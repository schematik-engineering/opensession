/**
 * Non-interactive authentication for the AWS-hosted MCP server.
 *
 * AWS Sign-In exchanges the instance role's SigV4 identity for a bearer token
 * scoped only to `aws-mcp.amazonaws.com`. The gateway and its agent children
 * cannot reach IMDS. A fixed root-owned helper runs the equally fixed AWS CLI
 * token command in a transient systemd unit outside that denied cgroup and
 * returns only the short-lived bearer token.
 *
 * Importing this module has no effects. Boot explicitly warms configured AWS
 * endpoints, while request paths refresh a token shortly before it expires.
 */

const HELPER = "/usr/local/libexec/opensession-aws-mcp-token";
const RESOURCE = "aws-mcp.amazonaws.com";
const REFRESH_AHEAD_MS = 5 * 60_000;
const RETRY_AFTER_ERROR_MS = 60_000;
const HELPER_TIMEOUT_MS = 25_000;

interface AwsMcpTarget {
  region: string;
  resource: typeof RESOURCE;
}

interface TokenEntry {
  token?: string;
  expiresAt?: number;
  inflight?: Promise<string>;
  error?: string;
  retryAt?: number;
}

export interface AwsMcpManagedAuth {
  kind: "aws-iam";
  state: "checking" | "ready" | "error";
  detail?: string;
}

export type AwsMcpTokenSpawn = (
  argv: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

function entries(): Map<string, TokenEntry> {
  const g = globalThis as any;
  return (g.__osAwsMcpTokens ??= new Map<string, TokenEntry>());
}

/** Official AWS MCP endpoints encode the token-signing region in the host. */
export function awsMcpTarget(
  serverUrl: string | undefined,
): AwsMcpTarget | undefined {
  if (!serverUrl) return undefined;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "https:") return undefined;
    const match = url.hostname.match(
      /^aws-mcp\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.api\.aws$/,
    );
    if (!match) return undefined;
    return { region: match[1]!, resource: RESOURCE };
  } catch {
    return undefined;
  }
}

export function isAwsMcpIamServer(serverUrl: string | undefined): boolean {
  return !!awsMcpTarget(serverUrl);
}

export function awsMcpTokenCommand(region: string): string[] {
  return ["sudo", "-n", HELPER, region];
}

const spawnHelper: AwsMcpTokenSpawn = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, HELPER_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      code: timedOut ? null : code,
      stdout,
      stderr: timedOut ? "AWS MCP token helper timed out" : stderr,
    };
  } finally {
    clearTimeout(timer);
  }
};

function errorDetail(value: unknown): string {
  return String(value || "AWS MCP token exchange failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function currentHeader(entry: TokenEntry | undefined): string | undefined {
  if (!entry?.token || !entry.expiresAt || entry.expiresAt <= Date.now())
    return undefined;
  return `Bearer ${entry.token}`;
}

function parseToken(stdout: string): { token: string; expiresIn: number } {
  let body: {
    accessToken?: unknown;
    tokenType?: unknown;
    expiresIn?: unknown;
  };
  try {
    body = JSON.parse(stdout.trim());
  } catch {
    throw new Error("AWS MCP token helper returned invalid JSON");
  }
  if (
    typeof body.accessToken !== "string" ||
    body.accessToken.length < 10 ||
    body.tokenType !== "Bearer" ||
    !Number.isInteger(body.expiresIn) ||
    (body.expiresIn as number) < 1 ||
    (body.expiresIn as number) > 3600
  ) {
    throw new Error("AWS MCP token helper returned an invalid token response");
  }
  return { token: body.accessToken, expiresIn: body.expiresIn as number };
}

/**
 * Return a valid bearer header, minting or refreshing through the fixed helper
 * when necessary. Concurrent calls for one region share the same exchange.
 */
export async function ensureAwsMcpIamAuth(
  serverUrl: string,
  spawn: AwsMcpTokenSpawn = spawnHelper,
): Promise<string> {
  const target = awsMcpTarget(serverUrl);
  if (!target) throw new Error("Not an AWS-hosted MCP server");

  const all = entries();
  const entry = all.get(target.region) ?? {};
  all.set(target.region, entry);
  const fresh = currentHeader(entry);
  if (fresh && entry.expiresAt! - Date.now() > REFRESH_AHEAD_MS) return fresh;
  if (entry.inflight) return entry.inflight;
  if (entry.retryAt && entry.retryAt > Date.now()) {
    if (fresh) return fresh;
    throw new Error(entry.error || "AWS MCP token exchange is retrying");
  }

  const previous = fresh;
  entry.inflight = (async () => {
    try {
      const result = await spawn(awsMcpTokenCommand(target.region));
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `AWS MCP token helper exited ${result.code ?? "after timeout"}`,
        );
      }
      const minted = parseToken(result.stdout);
      entry.token = minted.token;
      entry.expiresAt = Date.now() + minted.expiresIn * 1000;
      entry.error = undefined;
      entry.retryAt = undefined;
      console.log(
        `[aws-mcp] IAM bearer ready for ${target.region}, expires in ${minted.expiresIn}s`,
      );
      return `Bearer ${minted.token}`;
    } catch (error) {
      entry.error = errorDetail(error instanceof Error ? error.message : error);
      entry.retryAt = Date.now() + RETRY_AFTER_ERROR_MS;
      console.error(`[aws-mcp] token exchange failed: ${entry.error}`);
      if (previous) return previous;
      throw new Error(entry.error);
    } finally {
      entry.inflight = undefined;
    }
  })();
  return entry.inflight;
}

/**
 * Synchronous run-config path: return the cached token and start a refresh in
 * the background. Boot and the local MCP relay both use the awaited function.
 */
export function awsMcpIamAuthHeader(serverUrl: string): string | undefined {
  const target = awsMcpTarget(serverUrl);
  if (!target) return undefined;
  const entry = entries().get(target.region);
  const header = currentHeader(entry);
  if (
    (!entry?.retryAt || entry.retryAt <= Date.now()) &&
    (!entry?.expiresAt || entry.expiresAt - Date.now() <= REFRESH_AHEAD_MS)
  ) {
    void ensureAwsMcpIamAuth(serverUrl).catch(() => {});
  }
  return header;
}

export function awsMcpManagedAuth(
  serverUrl: string | undefined,
): AwsMcpManagedAuth | undefined {
  const target = awsMcpTarget(serverUrl);
  if (!target) return undefined;
  const entry = entries().get(target.region);
  if (currentHeader(entry)) return { kind: "aws-iam", state: "ready" };
  if (entry?.error)
    return { kind: "aws-iam", state: "error", detail: entry.error };
  return { kind: "aws-iam", state: "checking" };
}

/** Explicit cold-boot warmup. Failure is reported but never aborts the server. */
export async function warmAwsMcpIamAuth(
  servers: Record<string, unknown>,
): Promise<void> {
  const targets = Object.values(servers)
    .map((value) =>
      value && typeof value === "object"
        ? (value as { url?: string }).url
        : undefined,
    )
    .filter((url): url is string => !!awsMcpTarget(url));
  await Promise.allSettled(targets.map((url) => ensureAwsMcpIamAuth(url)));
}

/** Test-only cache reset; no production caller should discard a live token. */
export function __resetAwsMcpIamAuthForTest(): void {
  delete (globalThis as any).__osAwsMcpTokens;
}
