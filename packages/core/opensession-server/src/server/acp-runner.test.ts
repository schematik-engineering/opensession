import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  acpMcpServersForConfig,
  activeAcpRunCount,
  cancelAcpRun,
  runAcp,
} from "./acp-runner";
import {
  acpProviderStateDir,
  acpSessionStateDir,
  readAcpAccountBinding,
  removeAcpSessionState,
} from "./acp-state";
import { __setAcpProviderCommandForTest } from "./acp-config";
import {
  __setAcpAccountsPathForTest,
  addAcpAccountFromHome,
} from "./acp-accounts";
import type { RunAgentOpts } from "./agent-runner";

const fakeAgent = fileURLToPath(
  new URL("./testing/fake-acp-agent.ts", import.meta.url),
);
let scratch: string;
let previousJournal: string | undefined;
let previousTimeout: string | undefined;
let previousSessionsDir: string | undefined;
let previousAcpAccountsPath: string;

function stageAuth(value = "test-subscription-auth"): string {
  const runDir = join(scratch, "run");
  mkdirSync(runDir, { recursive: true });
  const auth = join(runDir, "acp-auth.json");
  writeFileSync(auth, JSON.stringify({ token: value }), { mode: 0o600 });
  chmodSync(auth, 0o600);
  process.env.OPENSESSION_RUN_JOURNAL = join(runDir, "journal.json");
  return auth;
}

function opts(
  prompt: string,
  sessionId?: string,
  osSessionId = `os-${crypto.randomUUID()}`,
): RunAgentOpts {
  return {
    prompt,
    sessionId,
    cwd: scratch,
    mode: "code",
    model: "grok/grok-4.6",
    mcpServers: [],
    startToken: `run-${crypto.randomUUID()}`,
    journal: { osSessionId, kind: "prompt" },
  };
}

async function collect(run: AsyncGenerator<any>): Promise<any[]> {
  const values: any[] = [];
  for await (const value of run) values.push(value);
  return values;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-acp-test-"));
  previousJournal = process.env.OPENSESSION_RUN_JOURNAL;
  previousTimeout = process.env.OPENSESSION_ACP_TURN_TIMEOUT_MS;
  previousSessionsDir = process.env.OPENSESSION_SESSIONS_DIR;
  process.env.OPENSESSION_SESSIONS_DIR = join(scratch, "sessions");
  previousAcpAccountsPath = __setAcpAccountsPathForTest(
    join(scratch, "acp-accounts.json"),
  ).store;
  __setAcpProviderCommandForTest("grok", [process.execPath, fakeAgent, "grok"]);
  __setAcpProviderCommandForTest("cursor", [
    process.execPath,
    fakeAgent,
    "cursor",
  ]);
});

afterEach(() => {
  __setAcpProviderCommandForTest("grok");
  __setAcpProviderCommandForTest("cursor");
  if (previousJournal === undefined) delete process.env.OPENSESSION_RUN_JOURNAL;
  else process.env.OPENSESSION_RUN_JOURNAL = previousJournal;
  if (previousTimeout === undefined)
    delete process.env.OPENSESSION_ACP_TURN_TIMEOUT_MS;
  else process.env.OPENSESSION_ACP_TURN_TIMEOUT_MS = previousTimeout;
  if (previousSessionsDir === undefined)
    delete process.env.OPENSESSION_SESSIONS_DIR;
  else process.env.OPENSESSION_SESSIONS_DIR = previousSessionsDir;
  __setAcpAccountsPathForTest(previousAcpAccountsPath);
  rmSync(scratch, { recursive: true, force: true });
});

describe("ACP runner", () => {
  test("adapts filtered HTTP and stdio MCP servers for ACP session setup", () => {
    expect(
      acpMcpServersForConfig(
        {
          linear: {
            type: "http",
            url: "https://mcp.example.test/rpc",
            headers: { Authorization: "Bearer projected" },
          },
        },
        {
          "opensession-sessions": {
            command: process.execPath,
            args: ["mcp-proxy"],
            env: { OPENSESSION_RPC_TOKEN: "run-scoped" },
          },
        },
      ),
    ).toEqual([
      {
        name: "opensession-sessions",
        command: process.execPath,
        args: ["mcp-proxy"],
        env: [{ name: "OPENSESSION_RPC_TOKEN", value: "run-scoped" }],
      },
      {
        type: "http",
        name: "linear",
        url: "https://mcp.example.test/rpc",
        headers: [{ name: "Authorization", value: "Bearer projected" }],
      },
    ]);
  });

  test("initializes, authenticates, prompts, normalizes, uses terminal, and scrubs auth", async () => {
    const projected = stageAuth();
    const events = await collect(runAcp(opts("normal"), "grok/grok-4.6"));
    expect(events.map((event) => event.type)).toEqual([
      "init",
      "tool_use",
      "tool_result",
      "text_chunk",
      "text_chunk",
      "done",
    ]);
    expect(events.find((event) => event.type === "tool_result")?.content).toBe(
      "credential-scrubbed",
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      provider: "grok",
      model: "grok/grok-4.6",
      result: "hello from ACP",
    });
    expect(existsSync(projected)).toBe(false);
    expect(activeAcpRunCount()).toBe(0);
  });

  test("reports a missing ACP executable without escaping the run stream", async () => {
    const projected = stageAuth();
    __setAcpProviderCommandForTest("grok", [
      join(scratch, "missing-grok-executable"),
    ]);

    const events = await collect(runAcp(opts("normal"), "grok/grok-4.6"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      provider: "grok",
      model: "grok/grok-4.6",
    });
    expect(events[0].content).toContain("missing-grok-executable");
    expect(existsSync(projected)).toBe(false);
    expect(activeAcpRunCount()).toBe(0);
  });

  test("persists native state and loads a later turn without replaying history", async () => {
    const osSessionId = "os-grok-resume";
    stageAuth();
    const first = await collect(
      runAcp(opts("normal", undefined, osSessionId), "grok/grok-4.6"),
    );
    const engineSessionId = first[0]?.sessionId;
    expect(engineSessionId).toBe("grok-session-new");
    stageAuth();
    const events = await collect(
      runAcp(opts("normal", engineSessionId, osSessionId), "grok/grok-4.6"),
    );
    expect(
      events
        .filter((event) => event.type === "text_chunk")
        .map((event) => event.text),
    ).toEqual(["hello ", "from ACP"]);
    expect(events[0]).toMatchObject({
      type: "init",
      sessionId: engineSessionId,
    });
    expect(
      existsSync(
        join(
          acpProviderStateDir(osSessionId, "grok"),
          `${engineSessionId}.state`,
        ),
      ),
    ).toBe(true);
    expect(
      Array.from(
        new Bun.Glob("**/auth.json*").scanSync(acpSessionStateDir(osSessionId)),
      ),
    ).toEqual([]);
  });

  test("scopes missing ACP message ids to one turn instead of overwriting a resumed reply", async () => {
    const osSessionId = "os-grok-idless-resume";
    stageAuth();
    const first = await collect(
      runAcp(
        opts("normal without message ids", undefined, osSessionId),
        "grok/grok-4.6",
      ),
    );
    const engineSessionId = first[0]?.sessionId;
    const firstBlockIds = [
      ...new Set(
        first
          .filter((event) => event.type === "text_chunk")
          .map((event) => event.blockId),
      ),
    ];
    expect(firstBlockIds).toHaveLength(1);

    stageAuth();
    const second = await collect(
      runAcp(
        opts("normal without message ids", engineSessionId, osSessionId),
        "grok/grok-4.6",
      ),
    );
    const secondBlockIds = [
      ...new Set(
        second
          .filter((event) => event.type === "text_chunk")
          .map((event) => event.blockId),
      ),
    ];
    expect(secondBlockIds).toHaveLength(1);
    expect(secondBlockIds[0]).not.toBe(firstBlockIds[0]);
  });

  test("maps Cursor's curated model name to its dynamic configuration value", async () => {
    stageAuth();
    const runOpts = { ...opts("normal"), model: "cursor/grok-4.6" };
    const events = await collect(runAcp(runOpts, "cursor/grok-4.6"));
    expect(events.at(-1)).toMatchObject({ type: "done", provider: "cursor" });
  });

  test("loads Cursor's provider-native ACP state on a later turn", async () => {
    const osSessionId = "os-cursor-resume";
    stageAuth();
    const firstOpts = {
      ...opts("normal", undefined, osSessionId),
      model: "cursor/grok-4.6",
    };
    const first = await collect(runAcp(firstOpts, "cursor/grok-4.6"));
    const engineSessionId = first[0]?.sessionId;
    expect(engineSessionId).toBe("cursor-session-new");
    expect(
      existsSync(
        join(
          acpProviderStateDir(osSessionId, "cursor"),
          `${engineSessionId}.state`,
        ),
      ),
    ).toBe(true);
    stageAuth();
    const secondOpts = {
      ...opts("normal", engineSessionId, osSessionId),
      model: "cursor/grok-4.6",
    };
    const second = await collect(runAcp(secondOpts, "cursor/grok-4.6"));
    expect(second.at(-1)).toMatchObject({
      type: "done",
      provider: "cursor",
      sessionId: engineSessionId,
    });
  });

  test("isolates and removes hashed per-session provider state", () => {
    const first = acpProviderStateDir("../../session-a", "grok");
    const second = acpProviderStateDir("session-b", "grok");
    expect(first).not.toBe(second);
    expect(first).toStartWith(join(scratch, "sessions", "acp-state"));
    expect(first).not.toContain("../");
    writeFileSync(join(first, "state"), "durable", { mode: 0o600 });
    removeAcpSessionState("../../session-a");
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  });

  test("cancels an in-flight prompt by immutable run token", async () => {
    stageAuth();
    const runOpts = opts("hang");
    const events: any[] = [];
    for await (const event of runAcp(runOpts, "grok/grok-4.6")) {
      events.push(event);
      if (event.type === "init")
        expect(cancelAcpRun(runOpts.startToken!)).toBe(true);
    }
    expect(events.at(-1)).toMatchObject({
      type: "error",
      content: "grok run cancelled",
    });
  });

  test("continues a headless ask turn after denying an unsafe terminal command", async () => {
    stageAuth();
    let askCalls = 0;
    const baseOpts = opts("unsafe then safe");
    const runOpts = {
      ...baseOpts,
      mode: "ask" as const,
      journal: { ...baseOpts.journal, kind: "automation" },
      onAskUser: async () => {
        askCalls++;
        return {
          behavior: "deny" as const,
          message: "This detached run has no interactive approver",
        };
      },
    };

    const events = await collect(runAcp(runOpts, "grok/grok-4.6"));

    expect(askCalls).toBe(0);
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === "tool_result")
        .map((event) => event.content),
    ).toEqual(["permission:deny", "credential-scrubbed"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      provider: "grok",
      result: "hello from ACP",
    });
  });

  test("does not continue after a human denies an ask-mode terminal command", async () => {
    stageAuth();
    const runOpts = {
      ...opts("human denial"),
      mode: "ask" as const,
      onAskUser: async () => ({
        behavior: "deny" as const,
        message: "Denied for test",
      }),
    };

    const events = await collect(runAcp(runOpts, "grok/grok-4.6"));

    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      content: "grok run cancelled",
    });
  });

  test("turn timeout cancels and reports a deterministic terminal error", async () => {
    stageAuth();
    process.env.OPENSESSION_ACP_TURN_TIMEOUT_MS = "50";
    const events = await collect(runAcp(opts("hang"), "grok/grok-4.6"));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.content).toContain("timed out");
  });

  test("malformed NDJSON fails without leaking the staged credential", async () => {
    const secret = "credential-that-must-never-appear";
    stageAuth(secret);
    const events = await collect(runAcp(opts("malformed"), "grok/grok-4.6"));
    expect(events.at(-1)?.type).toBe("error");
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  test("subscription exhaustion is explicit and never switches provider", async () => {
    stageAuth();
    const events = await collect(
      runAcp(opts("usage failure"), "grok/grok-4.6"),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      provider: "grok",
      usageLimitExhausted: true,
    });
    expect(events.some((event) => event.type === "model_switch")).toBe(false);
  });

  test("rotates a host run to the next Grok subscription before model fallback", async () => {
    delete process.env.OPENSESSION_RUN_JOURNAL;
    writeFileSync(
      join(scratch, "acp-accounts.json"),
      JSON.stringify({ hostOwners: { grok: "other-user" } }),
      { mode: 0o600 },
    );
    const add = (name: string) => {
      const home = join(scratch, name);
      const auth = join(home, ".grok/auth.json");
      mkdirSync(join(home, ".grok"), { recursive: true, mode: 0o700 });
      writeFileSync(
        auth,
        JSON.stringify({
          issuer: {
            key: name,
            email: `${name}@example.test`,
            auth_mode: "oidc",
            oidc_issuer: "https://auth.x.ai",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
        { mode: 0o600 },
      );
      chmodSync(auth, 0o600);
      const result = addAcpAccountFromHome("grok", home);
      if ("error" in result) throw new Error(result.error);
      return result;
    };
    const first = add("first-account");
    const second = add("second-account");
    const runOpts = {
      ...opts("usage first account", undefined, "os-grok-pool-rotation"),
      accountId: first.id,
    };

    const events = await collect(runAcp(runOpts, "grok/grok-4.6"));
    expect(events.filter((event) => event.type === "init")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      provider: "grok",
      result: "hello from ACP",
    });
    expect(readAcpAccountBinding("os-grok-pool-rotation", "grok")).toBe(
      second.id,
    );
  });
});
