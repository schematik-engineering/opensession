import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setAcpAccountsPathForTest,
  addAcpAccountFromHome,
  pickAcpAccount,
} from "./acp-accounts";
import { acpSessionExhaustedAccounts } from "./acp-state";
import {
  AcpAccountUnavailableError,
  __setHostedPhysicalRunnerForTest,
  continueRecoveredAcpUsage,
  hostedTerminalNeedsCoordinator,
  runAgentHosted,
  type HostedRunOpts,
} from "./host-client";
import type { StreamEvent } from "./run-events";
import type { ActiveRunRecord } from "./run-journal";
import type { RunHostSpec } from "../runner-host/protocol";

let scratch: string;
let previousAccountsPath: string;
let previousSessionsDir: string | undefined;

function addGrokAccount(name: string): string {
  const home = join(scratch, name);
  const auth = join(home, ".grok", "auth.json");
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
  const account = addAcpAccountFromHome("grok", home);
  if ("error" in account) throw new Error(account.error);
  return account.id;
}

async function collect(
  events: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function opts(overrides: Partial<HostedRunOpts> = {}): HostedRunOpts {
  return {
    osSessionId: "os-hosted-grok-rotation",
    prompt: "finish the task",
    cwd: scratch,
    model: "grok/grok-4.6",
    mcpServers: [],
    fallbackModel: "none",
    ...overrides,
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hosted-grok-coordinator-"));
  previousAccountsPath = __setAcpAccountsPathForTest(
    join(scratch, "accounts.json"),
  ).store;
  previousSessionsDir = process.env.OPENSESSION_SESSIONS_DIR;
  process.env.OPENSESSION_SESSIONS_DIR = join(scratch, "sessions");
});

afterEach(() => {
  __setHostedPhysicalRunnerForTest(null);
  __setAcpAccountsPathForTest(previousAccountsPath);
  if (previousSessionsDir === undefined)
    delete process.env.OPENSESSION_SESSIONS_DIR;
  else process.env.OPENSESSION_SESSIONS_DIR = previousSessionsDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("hosted model coordinator", () => {
  test("rotates one-account Grok hosts before returning a model result", async () => {
    const first = addGrokAccount("first");
    const second = addGrokAccount("second");
    const attempts: HostedRunOpts[] = [];
    __setHostedPhysicalRunnerForTest(async function* (attempt) {
      attempts.push(attempt);
      yield {
        type: "init",
        sessionId: `engine-${attempt.accountId}`,
        provider: "grok",
        model: "grok/grok-4.6",
      };
      if (attempt.accountId === first) {
        yield {
          type: "error",
          content: "subscription usage limit exhausted",
          provider: "grok",
          model: "grok/grok-4.6",
          usageLimitExhausted: true,
        };
        return;
      }
      yield { type: "text_chunk", text: "finished" };
      yield {
        type: "done",
        result: "finished",
        provider: "grok",
        model: "grok/grok-4.6",
      };
    });

    const events = await collect(runAgentHosted(opts({ accountId: first })));

    expect(attempts.map((attempt) => attempt.accountId)).toEqual([
      first,
      second,
    ]);
    expect(
      attempts.every(
        (attempt) =>
          attempt.accountStrict === true &&
          attempt.fallbackModel === "none" &&
          attempt.logicalFallbackModel === "none",
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "init")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", result: "finished" });
    expect(
      acpSessionExhaustedAccounts(opts().osSessionId, "grok").has(first),
    ).toBe(true);
    expect(
      pickAcpAccount("grok", { accountId: first, strict: true }),
    ).toBeUndefined();
  });

  test("a strict Grok pin never exposes a second account", async () => {
    const first = addGrokAccount("strict-first");
    addGrokAccount("strict-second");
    const attempts: HostedRunOpts[] = [];
    __setHostedPhysicalRunnerForTest(async function* (attempt) {
      attempts.push(attempt);
      yield {
        type: "error",
        content: "subscription usage limit exhausted",
        provider: "grok",
        model: "grok/grok-4.6",
        usageLimitExhausted: true,
      };
    });

    const events = await collect(
      runAgentHosted(opts({ accountId: first, accountStrict: true })),
    );

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.accountId).toBe(first);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      usageLimitExhausted: true,
    });
  });

  test("does not poison the Grok pool from a mismatched host result", async () => {
    const first = addGrokAccount("identity-first");
    addGrokAccount("identity-second");
    __setHostedPhysicalRunnerForTest(async function* () {
      yield {
        type: "error",
        content: "subscription usage limit exhausted",
        provider: "cursor",
        model: "cursor/auto",
        usageLimitExhausted: true,
      };
    });

    const events = await collect(
      runAgentHosted(opts({ accountId: first, fallbackModel: "none" })),
    );

    expect(events.at(-1)).toMatchObject({
      type: "error",
      provider: "grok",
      model: "grok/grok-4.6",
    });
    expect(events.at(-1)?.content).toContain("unexpected attempt identity");
    expect(
      acpSessionExhaustedAccounts(opts().osSessionId, "grok").has(first),
    ).toBe(false);
  });

  test("falls back models only after every Grok account is exhausted", async () => {
    addGrokAccount("pool-a");
    addGrokAccount("pool-b");
    const attempts: HostedRunOpts[] = [];
    __setHostedPhysicalRunnerForTest(async function* (attempt) {
      attempts.push(attempt);
      if (attempt.model === "grok/grok-4.6") {
        yield {
          type: "error",
          content: "subscription usage limit exhausted",
          provider: "grok",
          model: attempt.model,
          usageLimitExhausted: true,
        };
        return;
      }
      yield { type: "init", sessionId: "pi-fallback", model: attempt.model };
      yield { type: "done", result: "fallback complete", model: attempt.model };
    });

    const events = await collect(
      runAgentHosted(opts({ fallbackModel: "pi/openai/gpt-5.6-sol" })),
    );

    expect(attempts.map((attempt) => attempt.model)).toEqual([
      "grok/grok-4.6",
      "grok/grok-4.6",
      "pi/openai/gpt-5.6-sol",
    ]);
    expect(events.find((event) => event.type === "model_switch")).toMatchObject(
      {
        fromModel: "grok/grok-4.6",
        toModel: "pi/openai/gpt-5.6-sol",
      },
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: "fallback complete",
    });
  });

  test("drains a non-ACP host before reusing its logical run id", async () => {
    const attempts: HostedRunOpts[] = [];
    let firstDrained = false;
    __setHostedPhysicalRunnerForTest(async function* (attempt) {
      attempts.push(attempt);
      if (attempt.model === "pi/openai/gpt-5.6-sol") {
        yield {
          type: "error",
          content: "subscription usage limit exhausted",
          provider: "pi",
          model: attempt.model,
          usageLimitExhausted: true,
        };
        firstDrained = true;
        return;
      }
      expect(firstDrained).toBe(true);
      yield { type: "done", result: "fallback complete", model: attempt.model };
    });

    const events = await collect(
      runAgentHosted(
        opts({
          model: "pi/openai/gpt-5.6-sol",
          fallbackModel: "pi/anthropic/claude-opus-4-6",
        }),
      ),
    );

    expect(firstDrained).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.startToken).toBeTruthy();
    expect(attempts[1]?.startToken).toBe(attempts[0]?.startToken);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: "fallback complete",
    });
  });

  test("rotates only a typed account-local projection failure", async () => {
    const first = addGrokAccount("projection-a");
    const second = addGrokAccount("projection-b");
    const attempts: HostedRunOpts[] = [];
    __setHostedPhysicalRunnerForTest(async function* (attempt) {
      attempts.push(attempt);
      if (attempt.accountId === first)
        throw new AcpAccountUnavailableError(
          "grok",
          first,
          "Grok sign-in has expired",
        );
      yield {
        type: "done",
        result: "healthy account",
        provider: "grok",
        model: attempt.model,
      };
    });

    const events = await collect(runAgentHosted(opts({ accountId: first })));

    expect(attempts.map((attempt) => attempt.accountId)).toEqual([
      first,
      second,
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: "healthy account",
    });
  });

  test("retains only fallback-eligible physical terminals for coordination", () => {
    expect(
      hostedTerminalNeedsCoordinator({
        type: "error",
        content: "subscription usage limit exhausted",
        usageLimitExhausted: true,
      }),
    ).toBe(true);
    expect(
      hostedTerminalNeedsCoordinator({
        type: "error",
        content: "socket hang up",
      }),
    ).toBe(true);
    expect(
      hostedTerminalNeedsCoordinator({ type: "done", result: "complete" }),
    ).toBe(false);
  });

  test("continues account rotation and model fallback after gateway recovery", async () => {
    const first = addGrokAccount("recovered-a");
    const second = addGrokAccount("recovered-b");
    const mutableSpecAccount = "recovered-mutated-spec";
    const attempts: HostedRunOpts[] = [];
    __setHostedPhysicalRunnerForTest(async function* (attempt) {
      attempts.push(attempt);
      if (attempt.model === "grok/grok-4.6") {
        yield {
          type: "error",
          content: "subscription usage limit exhausted",
          provider: "grok",
          model: attempt.model,
          usageLimitExhausted: true,
        };
        return;
      }
      yield {
        type: "done",
        result: "continued after recovery",
        provider: "pi",
        model: attempt.model,
      };
    });
    const spec: RunHostSpec = {
      hostId: "recovered-run",
      osSessionId: "os-recovered-run",
      prompt: "finish the recovered task",
      cwd: scratch,
      model: "grok/grok-4.6",
      fallbackModel: "none",
      logicalFallbackModel: "pi/openai/gpt-5.6-sol",
      accountId: mutableSpecAccount,
      accountStrict: true,
      logicalAccountStrict: false,
      mcpServers: [],
    };
    const run: ActiveRunRecord = {
      runKey: spec.hostId,
      hostId: spec.hostId,
      osSessionId: spec.osSessionId,
      prompt: spec.prompt,
      cwd: spec.cwd,
      model: spec.model,
      fallbackModel: spec.logicalFallbackModel,
      accountId: second,
      physicalAccountId: first,
      accountStrict: false,
      startedAt: new Date().toISOString(),
    };

    const events = await collect(
      continueRecoveredAcpUsage(
        run,
        spec,
        {},
        {
          type: "error",
          content: "subscription usage limit exhausted",
          provider: "grok",
          model: spec.model,
          usageLimitExhausted: true,
        },
        false,
        "grok-session-recovered",
      ),
    );

    expect(attempts.map((attempt) => attempt.model)).toEqual([
      "grok/grok-4.6",
      "pi/openai/gpt-5.6-sol",
    ]);
    expect(attempts[0]?.accountId).toBe(second);
    expect(events.find((event) => event.type === "model_switch")).toMatchObject(
      { fromModel: "grok/grok-4.6", toModel: "pi/openai/gpt-5.6-sol" },
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: "continued after recovery",
    });
    expect(
      acpSessionExhaustedAccounts(spec.osSessionId, "grok").has(first),
    ).toBe(true);
    expect(
      acpSessionExhaustedAccounts(spec.osSessionId, "grok").has(second),
    ).toBe(true);
    expect(
      acpSessionExhaustedAccounts(spec.osSessionId, "grok").has(
        mutableSpecAccount,
      ),
    ).toBe(false);
  });

  test("a recovered strict Grok pin still uses its configured model fallback", async () => {
    const first = addGrokAccount("strict-recovered");
    const attempts: HostedRunOpts[] = [];
    __setHostedPhysicalRunnerForTest(async function* (attempt) {
      attempts.push(attempt);
      yield {
        type: "done",
        result: "strict fallback complete",
        provider: "pi",
        model: attempt.model,
      };
    });
    const spec: RunHostSpec = {
      hostId: "strict-recovered-run",
      osSessionId: "os-strict-recovered-run",
      prompt: "finish with the fallback",
      cwd: scratch,
      model: "grok/grok-4.6",
      fallbackModel: "none",
      logicalFallbackModel: "pi/openai/gpt-5.6-sol",
      accountId: first,
      accountStrict: true,
      logicalAccountId: first,
      logicalAccountStrict: true,
      mcpServers: [],
    };
    const run: ActiveRunRecord = {
      runKey: spec.hostId,
      hostId: spec.hostId,
      osSessionId: spec.osSessionId,
      prompt: spec.prompt,
      cwd: spec.cwd,
      model: spec.model,
      fallbackModel: spec.logicalFallbackModel,
      accountId: first,
      physicalAccountId: first,
      accountStrict: true,
      startedAt: new Date().toISOString(),
    };

    const events = await collect(
      continueRecoveredAcpUsage(
        run,
        spec,
        {},
        {
          type: "error",
          content: "subscription usage limit exhausted",
          provider: "grok",
          model: spec.model,
          usageLimitExhausted: true,
        },
        false,
        "grok-strict-session",
      ),
    );

    expect(attempts.map((attempt) => attempt.model)).toEqual([
      "pi/openai/gpt-5.6-sol",
    ]);
    expect(events.find((event) => event.type === "model_switch")).toMatchObject(
      { fromModel: "grok/grok-4.6", toModel: "pi/openai/gpt-5.6-sol" },
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: "strict fallback complete",
    });
  });
});
