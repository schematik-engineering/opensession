/** Browser-assisted sign-in for managed Grok and Cursor subscription pools. */
import { spawn, type ChildProcess } from "child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { stateDir } from "./paths";
import {
  ACP_PROVIDER_DEFINITIONS,
  acpProviderCommand,
  type AcpProvider,
} from "./acp-config";
import { addAcpAccountFromHome, type AcpAccountPublic } from "./acp-accounts";

const LOGIN_TIMEOUT_MS = 16 * 60 * 1000;
const RETENTION_MS = 60 * 60 * 1000;

export type AcpLoginState =
  | "starting"
  | "awaiting_authorization"
  | "done"
  | "error"
  | "cancelled";

interface AcpLogin {
  id: string;
  provider: AcpProvider;
  owner?: string;
  home: string;
  state: AcpLoginState;
  url?: string;
  code?: string;
  error?: string;
  account?: AcpAccountPublic;
  output: string;
  proc: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  finishedAt?: number;
}

export interface AcpLoginPublic {
  id: string;
  provider: AcpProvider;
  state: AcpLoginState;
  url?: string;
  code?: string;
  error?: string;
  account?: AcpAccountPublic;
}

const logins: Map<string, AcpLogin> = ((
  globalThis as any
).__acpSubscriptionLogins ??= new Map());

function publicLogin(login: AcpLogin): AcpLoginPublic {
  return {
    id: login.id,
    provider: login.provider,
    state: login.state,
    ...(login.url ? { url: login.url } : {}),
    ...(login.code ? { code: login.code } : {}),
    ...(login.error ? { error: login.error } : {}),
    ...(login.account ? { account: login.account } : {}),
  };
}

function terminal(state: AcpLoginState): boolean {
  return state === "done" || state === "error" || state === "cancelled";
}

function finish(login: AcpLogin, state: AcpLoginState, error?: string): void {
  if (terminal(login.state)) return;
  login.state = state;
  if (error) login.error = error;
  login.finishedAt = Date.now();
  if (login.timer) clearTimeout(login.timer);
  login.timer = null;
  if (login.proc?.exitCode === null) {
    try {
      login.proc.kill("SIGTERM");
    } catch {}
  }
  login.proc = null;
  if (state !== "done") {
    try {
      rmSync(login.home, { recursive: true, force: true });
    } catch {}
  }
}

function prune(): void {
  const now = Date.now();
  for (const [id, login] of logins) {
    if (login.finishedAt && now - login.finishedAt > RETENTION_MS)
      logins.delete(id);
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function ingest(login: AcpLogin, chunk: Buffer | string): void {
  login.output = (login.output + stripAnsi(String(chunk))).slice(-16_000);
  const grokUrl = login.output.match(
    /https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=([A-Z0-9-]+)/i,
  );
  const cursorUrl = login.output.match(
    /https:\/\/cursor\.com\/loginDeepControl\?[^\s]+/i,
  );
  if (grokUrl) {
    login.url = grokUrl[0];
    login.code = grokUrl[1].toUpperCase();
    login.state = "awaiting_authorization";
  } else if (cursorUrl) {
    login.url = cursorUrl[0];
    login.state = "awaiting_authorization";
  }
}

function identityFromOutput(login: AcpLogin): string | undefined {
  const match = login.output.match(
    /(?:logged in as|authenticated as)\s+([^\s]+)/i,
  );
  return match?.[1]?.trim();
}

async function cursorIdentity(
  executable: string,
  home: string,
): Promise<string | undefined> {
  return await new Promise((resolve) => {
    let output = "";
    const proc = spawn(executable, ["status"], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        LANG: process.env.LANG || "C.UTF-8",
        LC_ALL: process.env.LC_ALL || "C.UTF-8",
        NODE_ENV: process.env.NODE_ENV || "production",
      },
      stdio: "pipe",
      shell: false,
    });
    proc.stdin.end();
    const ingestStatus = (chunk: Buffer | string) => {
      output = (output + stripAnsi(String(chunk))).slice(-2_000);
    };
    proc.stdout?.on("data", ingestStatus);
    proc.stderr?.on("data", ingestStatus);
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }, 5_000);
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    proc.once("close", () => {
      clearTimeout(timer);
      resolve(
        output.match(/(?:logged in as|authenticated as)\s+([^\s]+)/i)?.[1],
      );
    });
  });
}

export function startAcpLogin(
  provider: AcpProvider,
  owner?: string,
): AcpLoginPublic | { error: string } {
  prune();
  const command = acpProviderCommand(provider);
  const executable = command[0].startsWith("/")
    ? command[0]
    : Bun.which(command[0]);
  if (!executable) {
    return {
      error: `${provider === "grok" ? "Grok" : "Cursor"} CLI is not installed on the OpenSession host`,
    };
  }
  const id = crypto.randomUUID();
  const home = stateDir(`acp-logins/${id}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);

  const args = provider === "grok" ? ["login", "--device-auth"] : ["login"];
  const login: AcpLogin = {
    id,
    provider,
    ...(owner?.trim() ? { owner: owner.trim() } : {}),
    home,
    state: "starting",
    output: "",
    proc: null,
    timer: null,
    createdAt: Date.now(),
  };
  logins.set(id, login);
  try {
    const proc = spawn(executable, args, {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        LANG: process.env.LANG || "C.UTF-8",
        LC_ALL: process.env.LC_ALL || "C.UTF-8",
        NODE_ENV: process.env.NODE_ENV || "production",
        NO_OPEN_BROWSER: "1",
      },
      stdio: "pipe",
      shell: false,
    });
    proc.stdin.end();
    login.proc = proc;
    proc.stdout?.on("data", (chunk) => ingest(login, chunk));
    proc.stderr?.on("data", (chunk) => ingest(login, chunk));
    proc.once("error", (error) => finish(login, "error", error.message));
    proc.once("close", async (code) => {
      if (terminal(login.state)) return;
      const authPath = join(
        home,
        ACP_PROVIDER_DEFINITIONS[provider].authRelativePath,
      );
      if (code !== 0 || !existsSync(authPath)) {
        finish(
          login,
          "error",
          `Sign-in ended before authorization completed${code === null ? "" : ` (exit ${code})`}`,
        );
        return;
      }
      const identity =
        identityFromOutput(login) ||
        (provider === "cursor"
          ? await cursorIdentity(executable, home)
          : undefined);
      const result = addAcpAccountFromHome(provider, home, {
        owner: login.owner,
        identity,
      });
      if ("error" in result) {
        finish(login, "error", result.error);
        return;
      }
      login.account = result;
      login.state = "done";
      login.finishedAt = Date.now();
      login.proc = null;
      if (login.timer) clearTimeout(login.timer);
      login.timer = null;
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    });
    login.timer = setTimeout(
      () => finish(login, "error", "Sign-in expired — start again"),
      LOGIN_TIMEOUT_MS,
    );
  } catch (error) {
    finish(
      login,
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
  return publicLogin(login);
}

export function getAcpLogin(id: string): AcpLoginPublic | null {
  prune();
  const login = logins.get(id);
  return login ? publicLogin(login) : null;
}

export function cancelAcpLogin(id: string): boolean {
  const login = logins.get(id);
  if (!login) return false;
  finish(login, "cancelled");
  return true;
}
