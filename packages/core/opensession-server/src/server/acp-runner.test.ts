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
import { __setAcpProviderCommandForTest } from "./acp-config";
import type { RunAgentOpts } from "./agent-runner";

const fakeAgent = fileURLToPath(
  new URL("./testing/fake-acp-agent.ts", import.meta.url),
);
let scratch: string;
let previousJournal: string | undefined;
let previousTimeout: string | undefined;

function stageAuth(value = "test-subscription-auth"): string {
  const runDir = join(scratch, "run");
  mkdirSync(runDir, { recursive: true });
  const auth = join(runDir, "acp-auth.json");
  writeFileSync(auth, JSON.stringify({ token: value }), { mode: 0o600 });
  chmodSync(auth, 0o600);
  process.env.OPENSESSION_RUN_JOURNAL = join(runDir, "journal.json");
  return auth;
}

function opts(prompt: string, sessionId?: string): RunAgentOpts {
  return {
    prompt,
    sessionId,
    cwd: scratch,
    mode: "code",
    model: "grok/grok-4.6",
    mcpServers: [],
    startToken: `run-${crypto.randomUUID()}`,
    journal: { osSessionId: `os-${crypto.randomUUID()}`, kind: "prompt" },
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

  test("loads a native session without replaying provider history", async () => {
    stageAuth();
    const events = await collect(
      runAcp(opts("normal", "grok-session-existing"), "grok/grok-4.6"),
    );
    expect(
      events
        .filter((event) => event.type === "text_chunk")
        .map((event) => event.text),
    ).toEqual(["hello ", "from ACP"]);
    expect(events[0]).toMatchObject({
      type: "init",
      sessionId: "grok-session-existing",
    });
  });

  test("maps Cursor's curated model name to its dynamic configuration value", async () => {
    stageAuth();
    const runOpts = { ...opts("normal"), model: "cursor/grok-4.6" };
    const events = await collect(runAcp(runOpts, "cursor/grok-4.6"));
    expect(events.at(-1)).toMatchObject({ type: "done", provider: "cursor" });
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
});
