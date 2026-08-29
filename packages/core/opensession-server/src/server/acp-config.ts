/** Configuration and narrow credential locations for subscription-backed ACP agents. */
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import type { Provider } from "./models";

export type AcpProvider = Extract<Provider, "grok" | "cursor">;

interface AcpProviderSettings {
  enabled?: boolean;
  authPath?: string;
  agentIdPath?: string;
}

interface AcpSettingsFile {
  grok?: AcpProviderSettings;
  cursor?: AcpProviderSettings;
}

export interface AcpProviderDefinition {
  id: AcpProvider;
  command: readonly [string, ...string[]];
  authMethod: string;
  authRelativePath: string;
  agentIdRelativePath?: string;
}

export const ACP_PROVIDER_DEFINITIONS: Record<
  AcpProvider,
  AcpProviderDefinition
> = {
  grok: {
    id: "grok",
    command: ["grok", "agent", "stdio"],
    authMethod: "cached_token",
    authRelativePath: ".grok/auth.json",
    agentIdRelativePath: ".grok/agent_id",
  },
  cursor: {
    id: "cursor",
    command: ["cursor-agent", "acp"],
    authMethod: "cursor_login",
    authRelativePath: ".config/cursor/auth.json",
  },
};

let commandOverrides: Partial<
  Record<AcpProvider, readonly [string, ...string[]]>
> = {};

export function acpProviderCommand(
  provider: AcpProvider,
): readonly [string, ...string[]] {
  return (
    commandOverrides[provider] || ACP_PROVIDER_DEFINITIONS[provider].command
  );
}

export function __setAcpProviderCommandForTest(
  provider: AcpProvider,
  command?: readonly [string, ...string[]],
): void {
  if (command) commandOverrides[provider] = command;
  else delete commandOverrides[provider];
}

export const ACP_CONFIG_PATH = stateDir("acp.json");

function settings(): AcpSettingsFile {
  try {
    const parsed = JSON.parse(readFileSync(ACP_CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isAcpProvider(provider: Provider): provider is AcpProvider {
  return provider === "grok" || provider === "cursor";
}

export function acpProviderConfigured(provider: AcpProvider): boolean {
  const config = settings()[provider];
  if (config?.enabled === false) return false;
  if (config?.enabled !== true) return false;
  if (existsSync(acpAuthSource(provider))) return true;
  // New sign-ins live in the managed ACP account pool rather than replacing
  // the original host credential. Read only the narrow path metadata here to
  // avoid a config↔account-pool module cycle.
  try {
    const parsed = JSON.parse(
      readFileSync(stateDir("acp-accounts.json"), "utf8"),
    );
    return Array.isArray(parsed?.accounts)
      ? parsed.accounts.some(
          (account: any) =>
            account?.provider === provider &&
            account?.source === "managed" &&
            typeof account?.authPath === "string" &&
            existsSync(account.authPath),
        )
      : false;
  } catch {
    return false;
  }
}

export function configuredAcpProviders(): Set<AcpProvider> {
  return new Set(
    (["grok", "cursor"] as const).filter((provider) =>
      acpProviderConfigured(provider),
    ),
  );
}

/** Host-side credential source. Never serialized into a run spec. */
export function acpAuthSource(provider: AcpProvider): string {
  return (
    settings()[provider]?.authPath || stateDir(`acp/${provider}/auth.json`)
  );
}

export function acpAgentIdSource(provider: AcpProvider): string | undefined {
  if (provider !== "grok") return undefined;
  return settings().grok?.agentIdPath || stateDir("acp/grok/agent_id");
}

const GROK_OIDC_ISSUER = "https://auth.x.ai";
const GROK_REFRESH_SKEW_MS = 5 * 60_000;
const grokRefreshes = new Map<string, Promise<string>>();

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function privateRegularFile(path: string): void {
  const metadata = statSync(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(
      `Grok subscription authentication file ${path} must be a private regular file (mode 0600 or stricter)`,
    );
  }
}

function grokReloginError(detail: string): Error {
  return new Error(
    `Grok subscription sign-in ${detail}; run grok login again on the OpenSession host`,
  );
}

function safeOAuthCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value)
    ? value
    : undefined;
}

export interface GrokAuthRefreshOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  refreshSkewMs?: number;
}

/**
 * Refresh Grok's native OIDC record at its host-only source before a Docker
 * launcher projects a short-lived copy. The refresh token is never returned,
 * logged, placed in a run spec, or made visible to the model sandbox.
 */
export async function refreshGrokAuthFile(
  path: string,
  options: GrokAuthRefreshOptions = {},
): Promise<boolean> {
  if (!existsSync(path))
    throw new Error("grok subscription authentication is not configured");
  privateRegularFile(path);

  let root: JsonRecord;
  try {
    const parsed = record(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) throw new Error("not an object");
    root = parsed;
  } catch {
    throw grokReloginError("file is invalid");
  }

  const match = Object.entries(root).find(([, value]) => {
    const auth = record(value);
    return auth?.auth_mode === "oidc" && auth.oidc_issuer === GROK_OIDC_ISSUER;
  });
  if (!match) throw grokReloginError("record is missing");
  const [recordKey, authValue] = match;
  const auth = record(authValue)!;
  const expiresAt = Date.parse(String(auth.expires_at || ""));
  const nowMs = options.nowMs ?? Date.now();
  const refreshSkewMs = options.refreshSkewMs ?? GROK_REFRESH_SKEW_MS;
  if (Number.isFinite(expiresAt) && expiresAt > nowMs + refreshSkewMs)
    return false;

  const refreshToken =
    typeof auth.refresh_token === "string" ? auth.refresh_token : "";
  const clientId =
    typeof auth.oidc_client_id === "string" ? auth.oidc_client_id : "";
  if (!refreshToken || !clientId) throw grokReloginError("has expired");

  const fetchImpl = options.fetchImpl || fetch;
  let discoveryResponse: Response;
  try {
    discoveryResponse = await fetchImpl(
      `${GROK_OIDC_ISSUER}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    throw grokReloginError("refresh service is unavailable");
  }
  if (!discoveryResponse.ok)
    throw grokReloginError(
      `refresh discovery failed (${discoveryResponse.status})`,
    );
  const discovery = record(await discoveryResponse.json().catch(() => null));
  const endpointValue = discovery?.token_endpoint;
  let tokenEndpoint: URL;
  try {
    tokenEndpoint = new URL(String(endpointValue || ""));
  } catch {
    throw grokReloginError("refresh discovery is invalid");
  }
  if (
    tokenEndpoint.protocol !== "https:" ||
    tokenEndpoint.origin !== GROK_OIDC_ISSUER
  ) {
    throw grokReloginError("refresh discovery is invalid");
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw grokReloginError("refresh service is unavailable");
  }
  const tokenBody = record(await tokenResponse.json().catch(() => null));
  if (!tokenResponse.ok) {
    const code = safeOAuthCode(tokenBody?.error);
    throw grokReloginError(
      `refresh failed (${tokenResponse.status}${code ? ` ${code}` : ""})`,
    );
  }
  const accessToken =
    typeof tokenBody?.access_token === "string" ? tokenBody.access_token : "";
  const expiresIn = Number(tokenBody?.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0)
    throw grokReloginError("refresh response is invalid");

  root[recordKey] = {
    ...auth,
    key: accessToken,
    ...(typeof tokenBody?.refresh_token === "string" && tokenBody.refresh_token
      ? { refresh_token: tokenBody.refresh_token }
      : {}),
    expires_at: new Date(nowMs + expiresIn * 1_000).toISOString(),
  };
  writeJsonAtomic(path, root, true, 0o600);
  return true;
}

/** Host-side source, refreshed once per process at a time before projection. */
export async function refreshAcpAuthSource(
  provider: AcpProvider,
  sourceOverride?: string,
): Promise<string> {
  const source = sourceOverride || acpAuthSource(provider);
  if (provider !== "grok") return source;
  const inflight = grokRefreshes.get(source);
  if (inflight) return await inflight;
  const refresh = refreshGrokAuthFile(source)
    .then(() => source)
    .finally(() => {
      if (grokRefreshes.get(source) === refresh) grokRefreshes.delete(source);
    });
  grokRefreshes.set(source, refresh);
  return await refresh;
}

/**
 * A Docker launcher projects credentials into the private run directory. The
 * ACP runner consumes and unlinks these before the first model-visible prompt.
 */
export function projectedAcpBootstrapFiles(): {
  auth: string;
  agentId: string;
} | null {
  const journal = process.env.OPENSESSION_RUN_JOURNAL;
  if (!journal) return null;
  const runDir = dirname(journal);
  return {
    auth: join(runDir, "acp-auth.json"),
    agentId: join(runDir, "acp-agent-id"),
  };
}
