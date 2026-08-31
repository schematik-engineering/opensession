/**
 * Browser-based OAuth for HTTP MCP servers (the feeds design — "easy to
 * connect any MCP, per user as well").
 *
 * Replaces the unusable headless flow (pi's CLI OAuth listens on the
 * VPS's 127.0.0.1, unreachable from the user's browser): Open Session runs the
 * OAuth 2.1 + PKCE flow itself with a redirect to
 * `<publicBaseUrl>/api/connections/mcp-oauth/callback`, so a
 * Connect button works from any signed-in device (iPhone PWA included).
 *
 * Grants are stored per server in ~/.opensession-mcp-oauth.json (0600):
 * one optional `shared` grant (workspace-wide identity, like the Linear/Plain
 * servers today) and per-user grants keyed by canonical team name (same
 * identity table as commit attribution — the github-auth.ts pattern). At run
 * time withDynamicCredentials() injects `Authorization: Bearer <token>` into
 * the server's headers — the run user's own grant when they have one, else
 * the shared grant. Engines never see refresh tokens; rotation happens here
 * (lazy kick + 2-min ticker parked on globalThis, refresh-on-first-use).
 *
 * Discovery follows the MCP auth spec: path-aware RFC 9728 protected-resource
 * metadata → authorization server → path-aware RFC 8414 AS metadata. Servers
 * then use either dynamic client registration (RFC 7591) or an explicitly
 * configured static client (required by hosted providers such as Google Drive).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes, createHash } from "crypto";
import { configuredServer, productName } from "./config";
import { statePath } from "./paths";
import { resolveTeammate } from "./shared/user-mappings";

let storePath = statePath(".opensession-mcp-oauth.json");

interface OauthEndpoints {
  authorize: string;
  token: string;
  register?: string;
}

interface Grant {
  tokens: {
    accessToken: string;
    refreshToken?: string;
    /** ms epoch; absent = no known expiry. */
    expiresAt?: number;
  };
  updatedAt: string;
  /** Team member (or GitHub login fallback) who completed the flow. */
  connectedBy?: string;
}

interface ServerAuth {
  serverUrl: string;
  resource?: string;
  /** scopes_supported from RFC 9728 metadata — some ASes (Cognito, e.g.
   *  Plain's) reject unknown scopes, so the authorize request must stick to
   *  what the resource advertises. */
  scopes?: string[];
  endpoints: OauthEndpoints;
  clientInfo: { clientId: string; clientSecret?: string };
  shared?: Grant;
  users?: Record<string, Grant>;
}

type Store = Record<string, ServerAuth>;

/**
 * Which grant slot on a ServerAuth we're talking about: the workspace-wide
 * one, or one team member's. Addressing a slot by name only ("shared" vs a
 * team name in the same string) let a caller pair one identity's grant with
 * another identity's slot, so a refresh could write a token into a slot it
 * never read from. The union keeps the two together.
 */
type GrantSlot = { kind: "shared" } | { kind: "user"; teamName: string };

/** A grant plus the slot it was read from — the expiry decision and the
 *  refreshed token's destination can no longer disagree. */
type GrantRef = GrantSlot & { grant: Grant };

/** Team name from a pending flow: absent = the shared grant. */
function slotFor(teamName?: string): GrantSlot {
  return teamName ? { kind: "user", teamName } : { kind: "shared" };
}

function slotLabel(slot: GrantSlot): string {
  return slot.kind === "shared" ? "shared" : slot.teamName;
}

function grantRef(
  auth: ServerAuth | undefined,
  slot: GrantSlot,
): GrantRef | undefined {
  const grant =
    slot.kind === "shared" ? auth?.shared : auth?.users?.[slot.teamName];
  return grant ? { ...slot, grant } : undefined;
}

function writeGrant(entry: ServerAuth, slot: GrantSlot, grant: Grant): void {
  if (slot.kind === "shared") entry.shared = grant;
  else entry.users = { ...(entry.users || {}), [slot.teamName]: grant };
}

function readStore(): Store {
  try {
    return JSON.parse(readFileSync(storePath, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Test-only store isolation. Passing no path restores normal resolution. */
export function __setMcpOauthStorePathForTest(path?: string): void {
  storePath = path || statePath(".opensession-mcp-oauth.json");
}

/**
 * Preset OAuth providers — servers whose OAuth is NOT the MCP spec (no RFC
 * 9728 discovery / dynamic registration). Slack: fixed app credentials from
 * the env, user-scope consent, token in authed_user.access_token (xoxp-,
 * "send messages as them"). The grant store/refresh/injection is shared
 * with MCP-spec grants; only start/complete differ.
 */
interface OauthPreset {
  authorize: string;
  token: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Query params for the authorize URL (slack: user_scope). */
  authorizeParams: Record<string, string>;
  /** Pull the token out of the exchange response. */
  extract(res: any): {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
  /** Env var the grant token is injected as for stdio MCP servers. */
  envVar?: string;
}

/** Static OAuth client settings accepted on an MCP server config. The direct
 * values match the shape documented by hosted providers such as Google Drive;
 * env indirection keeps operator-managed secrets out of mcp-config.json. */
export interface McpOauthClientConfig {
  clientId?: string;
  clientSecret?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
}

interface ResolvedOauthClient {
  clientId: string;
  clientSecret?: string;
}

export function resolveMcpOauthClient(
  config?: McpOauthClientConfig,
): ResolvedOauthClient | undefined {
  if (!config) return undefined;
  const clientId =
    config.clientId ||
    (config.clientIdEnv ? process.env[config.clientIdEnv] : undefined);
  const clientSecret =
    config.clientSecret ||
    (config.clientSecretEnv ? process.env[config.clientSecretEnv] : undefined);
  if (!clientId?.trim()) return undefined;
  return {
    clientId: clientId.trim(),
    ...(clientSecret?.trim() ? { clientSecret: clientSecret.trim() } : {}),
  };
}

const OAUTH_PRESETS: Record<string, OauthPreset> = {
  slack: {
    authorize: "https://slack.com/oauth/v2/authorize",
    token: "https://slack.com/api/oauth.v2.access",
    clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
    clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    authorizeParams: {
      user_scope:
        "channels:read,groups:read,channels:history,groups:history,chat:write,files:write,users:read,search:read",
    },
    extract: (res) => ({
      accessToken: res?.authed_user?.access_token,
      refreshToken: res?.authed_user?.refresh_token,
      expiresIn: res?.authed_user?.expires_in,
    }),
    envVar: "SLACK_BOT_TOKEN",
  },
};

export function oauthPresetFor(name: string): OauthPreset | undefined {
  const p = OAUTH_PRESETS[name.trim().toLowerCase()];
  if (!p) return undefined;
  return process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]
    ? p
    : undefined;
}

/** Providers that publish OAuth metadata but cannot complete Open Session's
 * dynamic-client flow. Keep these out of the generic Connect action so a
 * known configuration constraint is not surfaced as an origin 502. */
export function mcpOauthStartBlocker(
  name: string,
  serverUrl?: string,
  oauthClientConfig?: McpOauthClientConfig,
): string | undefined {
  let host = "";
  try {
    host = new URL(serverUrl || "").hostname.toLowerCase();
  } catch {}
  const provider =
    host === "mcp.fal.ai"
      ? "fal"
      : host === "api.x.com"
        ? "x"
        : host === "api.githubcopilot.com"
          ? "github"
          : host === "drivemcp.googleapis.com"
            ? "google-drive"
            : name.trim().toLowerCase();
  switch (provider) {
    case "fal":
      return "Fal's hosted MCP server currently uses API keys, not OAuth. Choose Connect with API token.";
    case "x":
      if (resolveMcpOauthClient(oauthClientConfig)) return undefined;
      return "X requires a pre-registered OAuth client and does not allow dynamic client registration.";
    case "github":
      return "GitHub MCP uses your connected GitHub account. Connect GitHub in Accounts first.";
    case "google-drive":
      if (resolveMcpOauthClient(oauthClientConfig)?.clientSecret)
        return undefined;
      return `Google Drive requires a Web application OAuth client with ${callbackUrl()} registered as an authorized redirect URI.`;
    default:
      return undefined;
  }
}

function callbackUrl(): string {
  return `${configuredServer().publicBaseUrl}/api/connections/mcp-oauth/callback`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** RFC 9728 puts a path-scoped resource's path after the well-known name. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const path = url.pathname === "/" ? "" : url.pathname;
  return unique([
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ]);
}

/** RFC 8414 uses the same prefix form when an issuer has a path. Keep the
 * legacy suffix candidates as fallbacks for providers that shipped them. */
export function authorizationServerMetadataUrls(asBase: string): string[] {
  const url = new URL(asBase);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  const base = asBase.replace(/\/$/, "");
  return unique([
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
    `${url.origin}/.well-known/openid-configuration${path}`,
  ]);
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

async function protectedResourceMetadata(
  serverUrl: string,
  timeoutMs = 10_000,
): Promise<ProtectedResourceMetadata | undefined> {
  for (const metadataUrl of protectedResourceMetadataUrls(serverUrl)) {
    try {
      const response = await fetch(metadataUrl, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const metadata = (await response.json()) as ProtectedResourceMetadata;
      if (metadata && typeof metadata === "object") return metadata;
    } catch {}
  }
  return undefined;
}

export async function hasOauthProtectedResource(
  serverUrl: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  return !!(await protectedResourceMetadata(serverUrl, timeoutMs));
}

/** RFC 9728 → RFC 8414 discovery for an MCP server URL. */
export async function discoverMcpOauth(serverUrl: string): Promise<{
  resource?: string;
  scopes?: string[];
  endpoints: OauthEndpoints;
}> {
  const origin = new URL(serverUrl).origin;
  let asBase = origin;
  let resource: string | undefined;
  let scopes: string[] | undefined;
  const pr = await protectedResourceMetadata(serverUrl);
  if (pr?.authorization_servers?.[0]) asBase = pr.authorization_servers[0];
  resource = pr?.resource;
  if (Array.isArray(pr?.scopes_supported) && pr.scopes_supported.length)
    scopes = pr.scopes_supported;
  for (const wk of authorizationServerMetadataUrls(asBase)) {
    try {
      const meta = (await (
        await fetch(wk, { signal: AbortSignal.timeout(10_000) })
      ).json()) as Record<string, string>;
      if (meta.authorization_endpoint && meta.token_endpoint)
        return {
          resource,
          scopes,
          endpoints: {
            authorize: meta.authorization_endpoint,
            token: meta.token_endpoint,
            register: meta.registration_endpoint,
          },
        };
    } catch {}
  }
  throw new Error(`No OAuth authorization-server metadata for ${serverUrl}`);
}

export class McpOauthConfigurationError extends Error {}

/** Ensure a registered public client for this server (cached in the store). */
async function ensureServerAuth(
  name: string,
  serverUrl: string,
  oauthClientConfig?: McpOauthClientConfig,
): Promise<ServerAuth> {
  const store = readStore();
  const cur = store[name];
  const configuredClient = resolveMcpOauthClient(oauthClientConfig);
  if (
    cur?.clientInfo?.clientId &&
    cur.serverUrl === serverUrl &&
    (!configuredClient || configuredClient.clientId === cur.clientInfo.clientId)
  ) {
    if (
      configuredClient?.clientSecret !== undefined &&
      configuredClient.clientSecret !== cur.clientInfo.clientSecret
    ) {
      cur.clientInfo.clientSecret = configuredClient.clientSecret;
      writeStore(store);
    }
    return cur;
  }
  const { resource, scopes, endpoints } = await discoverMcpOauth(serverUrl);
  if (configuredClient) {
    const next: ServerAuth = {
      serverUrl,
      resource,
      ...(scopes ? { scopes } : {}),
      endpoints,
      clientInfo: configuredClient,
      ...(cur ? { shared: cur.shared, users: cur.users } : {}),
    };
    const fresh = readStore();
    fresh[name] = next;
    writeStore(fresh);
    return next;
  }
  if (!endpoints.register)
    throw new McpOauthConfigurationError(
      `${name}: authorization server offers no dynamic client registration`,
    );
  const registrationUrl = new URL(endpoints.register);
  const registrationResponse = await fetch(endpoints.register, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: productName(),
      redirect_uris: [callbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const registrationText = await registrationResponse.text();
  if (!registrationResponse.ok) {
    if (
      registrationResponse.status === 403 &&
      registrationUrl.hostname === "api.figma.com"
    ) {
      throw new McpOauthConfigurationError(
        "Figma does not currently allow Open Session to connect. Its remote MCP server accepts only clients listed in the Figma MCP Catalog.",
      );
    }
    if (
      registrationResponse.status === 400 &&
      registrationText.includes("invalid_redirect_uri") &&
      registrationUrl.hostname === "vercel.com"
    ) {
      // Vercel MCP is a closed program: only clients Vercel has reviewed get
      // their redirect URI approved (docs/agent-resources/vercel-mcp).
      throw new McpOauthConfigurationError(
        "Vercel MCP only connects to AI clients Vercel has approved (Claude Code, ChatGPT, Cursor, …), so it rejects Open Session's callback URL.",
      );
    }
    const detail = registrationText.trim().slice(0, 200);
    throw new Error(
      `${name}: client registration failed (HTTP ${registrationResponse.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  let reg: { client_id?: string; error_description?: string };
  try {
    reg = JSON.parse(registrationText);
  } catch {
    throw new Error(`${name}: client registration returned invalid JSON`);
  }
  if (!reg.client_id)
    throw new Error(
      `${name}: client registration failed (${reg.error_description || "no client_id"})`,
    );
  const next: ServerAuth = {
    serverUrl,
    resource,
    ...(scopes ? { scopes } : {}),
    endpoints,
    clientInfo: { clientId: reg.client_id },
    ...(cur ? { shared: cur.shared, users: cur.users } : {}),
  };
  const fresh = readStore();
  fresh[name] = next;
  writeStore(fresh);
  return next;
}

// Pending flows keyed by state (10-min TTL); parked on globalThis so a
// frontend-triggered hot reload doesn't strand an in-flight consent.
interface PendingFlow {
  name: string;
  verifier: string;
  teamName?: string; // absent = shared grant
  createdAt: number;
}
const pending: Map<string, PendingFlow> = ((globalThis as any).__osMcpOauth ??=
  new Map<string, PendingFlow>());
const PENDING_TTL_MS = 10 * 60_000;

/** Which server a callback's state belongs to, for the result page's brand mark. */
export function pendingFlowServer(state: string): string | undefined {
  return pending.get(state)?.name;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint the authorize URL for a server. `forUser` (any user ref — name,
 * github login, slack id) makes it a per-user grant; absent = shared.
 */
export async function startMcpOauthFlow(
  name: string,
  serverUrl: string,
  forUser?: string,
  oauthClientConfig?: McpOauthClientConfig,
): Promise<{ url: string }> {
  const teamName = forUser ? resolveTeammate(forUser)?.name : undefined;
  if (forUser && !teamName)
    throw new Error(`"${forUser}" doesn't resolve to a configured teammate`);
  const preset = oauthPresetFor(name);
  if (preset) {
    const state = b64url(randomBytes(24));
    pending.set(state, {
      name,
      verifier: "",
      teamName,
      createdAt: Date.now(),
    });
    const url = new URL(preset.authorize);
    url.searchParams.set("client_id", process.env[preset.clientIdEnv]!);
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("state", state);
    for (const [k, v] of Object.entries(preset.authorizeParams))
      url.searchParams.set(k, v);
    // Ensure a store entry exists so grants have a home.
    const store = readStore();
    store[name] = store[name] || {
      serverUrl,
      endpoints: { authorize: preset.authorize, token: preset.token },
      clientInfo: { clientId: process.env[preset.clientIdEnv]! },
    };
    writeStore(store);
    return { url: url.toString() };
  }
  const auth = await ensureServerAuth(name, serverUrl, oauthClientConfig);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  for (const [k, v] of pending)
    if (Date.now() - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  pending.set(state, { name, verifier, teamName, createdAt: Date.now() });
  const url = new URL(auth.endpoints.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", auth.clientInfo.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Scope to what the resource advertises when it does (strict ASes like
  // Cognito reject unknown scopes); the permissive default otherwise.
  url.searchParams.set(
    "scope",
    auth.scopes?.join(" ") || "openid profile email offline_access",
  );
  url.searchParams.set("prompt", "consent");
  if (auth.resource) url.searchParams.set("resource", auth.resource);
  return { url: url.toString() };
}

/** Complete a flow from the callback redirect. Returns what got connected. */
export async function completeMcpOauthFlow(
  state: string,
  code: string,
  completedBy?: string,
): Promise<{ name: string; teamName?: string }> {
  const flow = pending.get(state);
  if (!flow || Date.now() - flow.createdAt > PENDING_TTL_MS)
    throw new Error("This connect link expired. Start again from Connections.");
  pending.delete(state);
  const preset = oauthPresetFor(flow.name);
  if (preset) {
    const body = new URLSearchParams({
      code,
      client_id: process.env[preset.clientIdEnv]!,
      client_secret: process.env[preset.clientSecretEnv]!,
      redirect_uri: callbackUrl(),
    });
    const res = (await (
      await fetch(preset.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as any;
    const tok = preset.extract(res);
    if (!tok.accessToken)
      throw new Error(
        `Token exchange failed: ${res?.error || "no user token in response"}`,
      );
    const grant: Grant = {
      tokens: {
        accessToken: tok.accessToken,
        ...(tok.refreshToken ? { refreshToken: tok.refreshToken } : {}),
        ...(tok.expiresIn
          ? { expiresAt: Date.now() + tok.expiresIn * 1000 }
          : {}),
      },
      updatedAt: new Date().toISOString(),
      ...(completedBy ? { connectedBy: completedBy } : {}),
    };
    const fresh = readStore();
    const entry = fresh[flow.name];
    if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
    writeGrant(entry, slotFor(flow.teamName), grant);
    writeStore(fresh);
    return { name: flow.name, teamName: flow.teamName };
  }
  const store = readStore();
  const auth = store[flow.name];
  if (!auth) throw new Error(`No pending registration for ${flow.name}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    client_id: auth.clientInfo.clientId,
    code_verifier: flow.verifier,
  });
  if (auth.clientInfo.clientSecret)
    body.set("client_secret", auth.clientInfo.clientSecret);
  if (auth.resource) body.set("resource", auth.resource);
  const res = (await (
    await fetch(auth.endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    })
  ).json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.access_token)
    throw new Error(
      `Token exchange failed: ${res.error_description || res.error || "no access_token"}`,
    );
  const grant: Grant = {
    tokens: {
      accessToken: res.access_token,
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
      ...(res.expires_in
        ? { expiresAt: Date.now() + res.expires_in * 1000 }
        : {}),
    },
    updatedAt: new Date().toISOString(),
    ...(completedBy ? { connectedBy: completedBy } : {}),
  };
  const fresh = readStore();
  const entry = fresh[flow.name];
  if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
  writeGrant(entry, slotFor(flow.teamName), grant);
  writeStore(fresh);
  return { name: flow.name, teamName: flow.teamName };
}

const REFRESH_AHEAD_MS = 5 * 60_000;

async function refreshGrant(
  name: string,
  auth: ServerAuth,
  ref: GrantRef,
): Promise<void> {
  const { grant } = ref;
  if (!grant.tokens.refreshToken) return;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: grant.tokens.refreshToken,
    client_id: auth.clientInfo.clientId,
  });
  if (auth.clientInfo.clientSecret)
    body.set("client_secret", auth.clientInfo.clientSecret);
  if (auth.resource) body.set("resource", auth.resource);
  try {
    const res = (await (
      await fetch(auth.endpoints.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!res.access_token) return;
    const next: Grant = {
      ...grant,
      tokens: {
        accessToken: res.access_token,
        refreshToken: res.refresh_token || grant.tokens.refreshToken,
        ...(res.expires_in
          ? { expiresAt: Date.now() + res.expires_in * 1000 }
          : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    const store = readStore();
    const entry = store[name];
    if (!entry) return;
    writeGrant(entry, ref, next);
    writeStore(store);
  } catch (e) {
    console.error(
      `[mcp-oauth] refresh failed for ${name}/${slotLabel(ref)}:`,
      e,
    );
  }
}

async function refreshExpiring(): Promise<void> {
  const store = readStore();
  for (const [name, auth] of Object.entries(store)) {
    const slots: GrantSlot[] = [
      ...(auth.shared ? [{ kind: "shared" } as const] : []),
      ...Object.keys(auth.users || {}).map(
        (teamName) => ({ kind: "user", teamName }) as const,
      ),
    ];
    for (const slot of slots) {
      const ref = grantRef(auth, slot);
      const exp = ref?.grant.tokens.expiresAt;
      if (
        ref?.grant.tokens.refreshToken &&
        exp &&
        exp - Date.now() < REFRESH_AHEAD_MS
      )
        await refreshGrant(name, auth, ref);
    }
  }
}

// Lazy 2-minute refresh ticker (parked on globalThis; started on first store
// use, so no entry-file side-effect import is needed).
function ensureTicker(): void {
  const g = globalThis as any;
  if (g.__osMcpOauthTicker) return;
  g.__osMcpOauthTicker = setInterval(() => {
    refreshExpiring().catch(() => {});
  }, 2 * 60_000);
  refreshExpiring().catch(() => {});
}

/**
 * The Authorization header value for a server, for a run by `user` — the
 * user's own grant first (per-user MCP identity), else the shared grant.
 * Sync (called from filterMcpServers); a stale token still gets returned
 * while the ticker refreshes in the background — the server 401s at worst,
 * which reads as "tools unavailable this turn", never a crashed run.
 */
export function mcpAuthHeader(name: string, user?: string): string | undefined {
  return mcpUserGrantHeader(name, user) ?? mcpSharedGrantHeader(name);
}

/** The user's own grant ONLY (no shared fallback) — lets callers order
 *  identities explicitly (e.g. session creator first, then prompter). */
export function mcpUserGrantHeader(
  name: string,
  user?: string,
): string | undefined {
  if (!user) return undefined;
  const teamName = resolveTeammate(user)?.name;
  if (!teamName) return undefined;
  return grantHeader(name, { kind: "user", teamName });
}

/** The workspace-wide grant ONLY. */
export function mcpSharedGrantHeader(name: string): string | undefined {
  return grantHeader(name, { kind: "shared" });
}

function grantHeader(name: string, slot: GrantSlot): string | undefined {
  ensureTicker();
  const auth = readStore()[name];
  const ref = grantRef(auth, slot);
  if (!auth || !ref) return undefined;
  const { accessToken, expiresAt, refreshToken } = ref.grant.tokens;
  if (expiresAt && expiresAt - Date.now() < REFRESH_AHEAD_MS && refreshToken)
    refreshGrant(name, auth, ref).catch(() => {});
  if (expiresAt && expiresAt < Date.now()) return undefined;
  return `Bearer ${accessToken}`;
}

/** Connection status for the UI: who's connected on each grant. */
export function mcpOauthStatus(name: string): {
  shared?: { connectedBy?: string; updatedAt: string };
  users: string[];
} {
  const auth = readStore()[name];
  return {
    ...(auth?.shared
      ? {
          shared: {
            connectedBy: auth.shared.connectedBy,
            updatedAt: auth.shared.updatedAt,
          },
        }
      : {}),
    users: Object.keys(auth?.users || {}),
  };
}

// OAuth-capability probe (RFC 9728 protected-resource metadata followed by
// RFC 8414 authorization-server metadata) — drives Connect visibility for servers that
// run on a static workspace key today (e.g. posthog).
//
// The answer is kept on disk, not only in memory, because it decides
// MEMBERSHIP of the My accounts list rather than one row's state: a cold
// process cannot say which tools belong on that list at all, so the panel
// would have to wait on a probe per configured server before it could draw a
// single row. Whether a server URL offers a flow Open Session can actually
// start is a stable fact, so the last answer is a good one to show while a fresh
// probe runs behind it.
//
// A probe that never got an answer is remembered in memory only, and briefly:
// a network blip must not persist "this tool has no personal sign-in" and drop
// the row from everyone's list for an hour.
const CAPABLE_PATH = statePath(".opensession-mcp-capable.json");
const CAPABLE_TTL_MS = 60 * 60_000;
const CAPABLE_ERROR_TTL_MS = 60_000;

/** `soft`: the probe errored, so this is a placeholder that keeps us from
 *  hammering an unreachable origin, not a fact worth persisting. */
interface Capability {
  capable: boolean;
  ts: number;
  soft?: boolean;
}

let capableCache: Map<string, Capability> | null = null;
const capableInflight = new Map<string, Promise<boolean>>();

function capabilities(): Map<string, Capability> {
  if (capableCache) return capableCache;
  capableCache = new Map();
  try {
    const raw = JSON.parse(readFileSync(CAPABLE_PATH, "utf8")) as Record<
      string,
      Capability
    >;
    for (const [serverUrl, e] of Object.entries(raw))
      if (typeof e?.capable === "boolean" && typeof e?.ts === "number")
        capableCache.set(serverUrl, { capable: e.capable, ts: e.ts });
  } catch {}
  return capableCache;
}

function capabilityFresh(e: Capability): boolean {
  return Date.now() - e.ts < (e.soft ? CAPABLE_ERROR_TTL_MS : CAPABLE_TTL_MS);
}

function capabilityKey(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function probeCapable(serverUrl: string): Promise<boolean> {
  const key = capabilityKey(serverUrl);
  if (!key) return Promise.resolve(false);
  const running = capableInflight.get(key);
  if (running) return running;
  const p = (async () => {
    let capable = false;
    let answered = false;
    try {
      const discovery = await discoverMcpOauth(serverUrl);
      capable = !!discovery.endpoints.register;
      answered = true;
    } catch {}
    capabilities().set(key, {
      capable,
      ts: Date.now(),
      ...(answered ? {} : { soft: true }),
    });
    if (answered) persistCapabilities();
    return capable;
  })().finally(() => capableInflight.delete(key));
  capableInflight.set(key, p);
  return p;
}

function persistCapabilities(): void {
  const out: Record<string, Capability> = {};
  for (const [serverUrl, e] of capabilities()) if (!e.soft) out[serverUrl] = e;
  try {
    writeFileSync(CAPABLE_PATH, JSON.stringify(out, null, 2) + "\n");
  } catch {}
}

/**
 * The last known capability answer, refreshing a stale one in the background.
 * `undefined` means no probe has ever finished for this server URL, which the
 * caller should report as still checking rather than as "no personal sign-in
 * here" — the two look identical to a reader and only one of them is true.
 */
export function cachedOauthCapable(serverUrl: string): boolean | undefined {
  const key = capabilityKey(serverUrl);
  if (!key) return false;
  const hit = capabilities().get(key);
  if (!hit || !capabilityFresh(hit)) probeCapable(serverUrl).catch(() => {});
  return hit?.capable;
}

export async function isOauthCapable(serverUrl: string): Promise<boolean> {
  const key = capabilityKey(serverUrl);
  if (!key) return false;
  const hit = capabilities().get(key);
  if (hit && capabilityFresh(hit)) return hit.capable;
  return probeCapable(serverUrl);
}

/** Raw grant token (no "Bearer " prefix) — stdio env injection. */
export function mcpUserGrantToken(
  name: string,
  user?: string,
): string | undefined {
  const h = mcpUserGrantHeader(name, user);
  return h?.replace(/^Bearer\s+/i, "");
}

/** Any grant at all for this server (shared or any user's)? */
export function hasMcpOauthGrant(name: string, user?: string): boolean {
  if (user) return !!mcpAuthHeader(name, user);
  const auth = readStore()[name];
  return !!auth?.shared || Object.keys(auth?.users || {}).length > 0;
}

/** Drop a grant (Disconnect in the UI). */
export function removeMcpOauthGrant(name: string, forUser?: string): boolean {
  const store = readStore();
  const auth = store[name];
  if (!auth) return false;
  if (forUser) {
    const teamName = resolveTeammate(forUser)?.name;
    if (!teamName || !auth.users?.[teamName]) return false;
    delete auth.users[teamName];
  } else {
    if (!auth.shared) return false;
    delete auth.shared;
  }
  writeStore(store);
  return true;
}

// ── Manual token connect ──────────────────────────────────────────────────
// Some providers gate OAuth client registration (Vercel approves only its
// own list of AI clients), but every user can mint a personal API token.
// A validated pasted token is stored as a grant, so it rides the exact same
// per-run injection path as an OAuth grant — no separate plumbing.

const TOKEN_VALIDATORS: Record<
  string,
  (token: string) => Promise<{ ok: true } | { ok: false; error: string }>
> = {
  fal: async (token) => {
    const res = await fetch("https://mcp.fal.ai/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "Open Session", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403)
      return {
        ok: false,
        error:
          "Fal rejected that key. Create an API-scoped key in Fal and paste it again.",
      };
    if (!res.ok)
      return {
        ok: false,
        error: `Could not check the key with Fal (HTTP ${res.status})`,
      };
    return { ok: true };
  },
  vercel: async (token) => {
    const res = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403)
      return {
        ok: false,
        error:
          "Vercel rejected that token. Create a new one at vercel.com/account/settings/tokens and paste it again.",
      };
    if (!res.ok)
      return {
        ok: false,
        error: `Could not check the token with Vercel (HTTP ${res.status})`,
      };
    return { ok: true };
  },
  vero: async (token) => {
    const res = await fetch("https://api.getvero.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "Open Session", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403)
      return {
        ok: false,
        error:
          "Vero rejected that key. Create a Campaigns API secret key in Vero and paste it again.",
      };
    if (!res.ok)
      return {
        ok: false,
        error: `Could not check the key with Vero (HTTP ${res.status})`,
      };
    return { ok: true };
  },
};

/** Can this server be connected by pasting a personal API token? */
function tokenProvider(name: string, serverUrl?: string): string {
  try {
    if (new URL(serverUrl || "").hostname.toLowerCase() === "mcp.fal.ai")
      return "fal";
  } catch {}
  return name.trim().toLowerCase();
}

export function supportsManualToken(name: string, serverUrl?: string): boolean {
  return !!TOKEN_VALIDATORS[tokenProvider(name, serverUrl)];
}

/** Validate a provider token without persisting it. */
export async function validateManualMcpToken(
  name: string,
  token: string,
  serverUrl?: string,
): Promise<void> {
  const validate = TOKEN_VALIDATORS[tokenProvider(name, serverUrl)];
  if (!validate) throw new Error(`${name} has no token connect flow`);
  const checked = await validate(token);
  if (!checked.ok) throw new Error(checked.error);
}

/** Validate a pasted API token live, then store it as a grant. */
export async function saveManualMcpGrant(
  name: string,
  serverUrl: string,
  token: string,
  opts: { connectedBy?: string; forUser?: string } = {},
): Promise<void> {
  await validateManualMcpToken(name, token, serverUrl);
  const teamName = opts.forUser
    ? resolveTeammate(opts.forUser)?.name
    : undefined;
  if (opts.forUser && !teamName)
    throw new Error(
      `"${opts.forUser}" doesn't resolve to a configured teammate`,
    );
  const store = readStore();
  const entry = store[name] ?? {
    serverUrl,
    endpoints: { authorize: "", token: "" },
    clientInfo: { clientId: "manual-token" },
  };
  entry.serverUrl = serverUrl;
  store[name] = entry;
  writeGrant(entry, slotFor(teamName), {
    tokens: { accessToken: token },
    updatedAt: new Date().toISOString(),
    ...(opts.connectedBy ? { connectedBy: opts.connectedBy } : {}),
  });
  writeStore(store);
}
