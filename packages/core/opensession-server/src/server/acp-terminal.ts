/** ACP client-owned terminal implementation, contained to the session workspace. */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { resolve, sep } from "path";
import type * as schema from "@agentclientprotocol/sdk";

interface TerminalState {
  process: ChildProcessWithoutNullStreams;
  output: string;
  outputBytes: number;
  limit: number;
  truncated: boolean;
  exitStatus?: schema.TerminalExitStatus;
  exited: Promise<schema.TerminalExitStatus>;
}

const SENSITIVE_ENV =
  /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|API_KEY|(?:^|_)KEY(?:_|$)|OPENSESSION_(?:ACP|RPC|RUN_WS))/i;
const MAX_OUTPUT_BYTES = 1_000_000;

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function appendOutput(state: TerminalState, chunk: Buffer): void {
  state.output += chunk.toString("utf8");
  state.outputBytes = Buffer.byteLength(state.output);
  if (state.outputBytes <= state.limit) return;
  state.truncated = true;
  const bytes = Buffer.from(state.output, "utf8");
  state.output = bytes.subarray(bytes.length - state.limit).toString("utf8");
  state.outputBytes = Buffer.byteLength(state.output);
}

export class AcpTerminalManager {
  private readonly root: string;
  private readonly home: string;
  private readonly terminals = new Map<string, TerminalState>();

  constructor(root: string, home: string) {
    this.root = resolve(root);
    this.home = resolve(home);
  }

  async createTerminal(
    params: schema.CreateTerminalRequest,
  ): Promise<schema.CreateTerminalResponse> {
    const cwd = resolve(params.cwd || this.root);
    if (!isInside(this.root, cwd))
      throw new Error(`ACP terminal cwd is outside the workspace: ${cwd}`);
    const requestedEnv = Object.fromEntries(
      (params.env || [])
        .filter(({ name }) => !SENSITIVE_ENV.test(name))
        .map(({ name, value }) => [name, value]),
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.home,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
      TERM: process.env.TERM || "xterm-256color",
      TMPDIR: process.env.TMPDIR,
      OPENSESSION_SCRATCH: process.env.OPENSESSION_SCRATCH,
      NODE_ENV: process.env.NODE_ENV || "production",
      ...requestedEnv,
    };
    for (const key of Object.keys(env))
      if (env[key] === undefined) delete env[key];

    const child = spawn(params.command, params.args || [], {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.stdin.end();
    const terminalId = crypto.randomUUID();
    let settle!: (status: schema.TerminalExitStatus) => void;
    const exited = new Promise<schema.TerminalExitStatus>((resolveExit) => {
      settle = resolveExit;
    });
    const state: TerminalState = {
      process: child,
      output: "",
      outputBytes: 0,
      limit: Math.min(
        Math.max(1, params.outputByteLimit || MAX_OUTPUT_BYTES),
        MAX_OUTPUT_BYTES,
      ),
      truncated: false,
      exited,
    };
    child.stdout.on("data", (chunk: Buffer) => appendOutput(state, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(state, chunk));
    child.once("error", (error) =>
      appendOutput(state, Buffer.from(String(error))),
    );
    child.once("exit", (code, signal) => {
      state.exitStatus = { exitCode: code, signal };
      settle(state.exitStatus);
    });
    this.terminals.set(terminalId, state);
    return { terminalId };
  }

  async terminalOutput(
    params: schema.TerminalOutputRequest,
  ): Promise<schema.TerminalOutputResponse> {
    const state = this.require(params.terminalId);
    return {
      output: state.output,
      truncated: state.truncated,
      exitStatus: state.exitStatus,
    };
  }

  async waitForTerminalExit(
    params: schema.WaitForTerminalExitRequest,
  ): Promise<schema.WaitForTerminalExitResponse> {
    return await this.require(params.terminalId).exited;
  }

  async killTerminal(
    params: schema.KillTerminalRequest,
  ): Promise<schema.KillTerminalResponse> {
    this.kill(this.require(params.terminalId));
    return {};
  }

  async releaseTerminal(
    params: schema.ReleaseTerminalRequest,
  ): Promise<schema.ReleaseTerminalResponse> {
    const state = this.require(params.terminalId);
    this.kill(state);
    this.terminals.delete(params.terminalId);
    return {};
  }

  async close(): Promise<void> {
    for (const state of this.terminals.values()) this.kill(state);
    this.terminals.clear();
  }

  private require(id: string): TerminalState {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`Unknown ACP terminal: ${id}`);
    return terminal;
  }

  private kill(state: TerminalState): void {
    if (state.exitStatus) return;
    try {
      process.kill(-state.process.pid!, "SIGTERM");
    } catch {
      try {
        state.process.kill("SIGTERM");
      } catch {}
    }
  }
}
