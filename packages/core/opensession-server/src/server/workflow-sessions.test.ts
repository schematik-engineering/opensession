import { describe, expect, test } from "bun:test";
import type {
  CreateSessionOpts,
  SessionControl,
  SessionSummary,
} from "./session-control";
import { createWorkflowSessionController } from "./workflow-sessions";

function summary(
  id: string,
  patch: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    local: true,
    claudeSessionId: "engine-1",
    source: "opensession",
    branch: "main",
    worktreeDir: "/repo/main",
    createdBy: "Jaap",
    startedBy: "Jaap",
    title: id,
    lastActivity: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    isRunning: false,
    transcriptPath: null,
    repo: "renderer",
    mode: "code",
    state: "idle",
    queuedCount: 0,
    controllable: true,
    ...patch,
  };
}

function harness(options?: {
  pushed?: (session: SessionSummary) => boolean;
  dirty?: (session: SessionSummary) => boolean;
  parent?: Partial<SessionSummary>;
}) {
  const sessions = new Map<string, SessionSummary>();
  sessions.set("parent", summary("parent", options?.parent));
  const creates: CreateSessionOpts[] = [];
  const sends: Array<{ id: string; message: string }> = [];
  const cancels: string[] = [];
  let next = 0;
  const control: SessionControl = {
    listSessions: () => [...sessions.values()],
    getSession: (id) => sessions.get(id),
    transcriptTail: async () => [],
    answerQuestion: () => false,
    async deliverToSession(id, message) {
      sends.push({ id, message });
      return { status: "steered", message: "sent" };
    },
    cancelSession(id) {
      cancels.push(id);
      const current = sessions.get(id);
      if (current)
        sessions.set(id, {
          ...current,
          state: "idle",
          isRunning: false,
        });
      return true;
    },
    async createSession(input) {
      creates.push(input);
      const id = `child-${++next}`;
      sessions.set(
        id,
        summary(id, {
          branch: input.branch || `generated-${next}`,
          repo: input.repo,
          worktreeDir: `/worktrees/${input.branch || `generated-${next}`}`,
          parentSessionId: input.parentSessionId,
          state: "running",
          isRunning: true,
          claudeSessionId: "",
          mcpServers: input.mcpServers,
          model: input.model,
          accountId: input.accountId,
          spawnDepth: input.spawnDepth,
        }),
      );
      return { id, createdBy: "Jaap", createdAt: new Date(0).toISOString() };
    },
  };
  const controller = createWorkflowSessionController({
    parentSessionId: "parent",
    user: "Jaap",
    allowSpawning: true,
    maxDepth: 2,
    deps: {
      control,
      baseUrl: "https://os.example.test",
      branchPushed: async (session) => options?.pushed?.(session) ?? true,
      hasUncommittedChanges: async (session) =>
        options?.dirty?.(session) ?? false,
      requireCommittedRef: async (_repo, ref) => {
        if (ref === "missing") throw new Error("not a usable committed branch");
      },
      resolveRepo: (session, repo) =>
        !repo || repo === session.repo || repo === "other"
          ? {
              repo: repo || session.repo || "renderer",
              dir: session.worktreeDir || "/repo/main",
              branch: session.branch || undefined,
              primary: repo === session.repo,
            }
          : null,
    },
  });
  return { controller, creates, sends, cancels, sessions };
}

const foundationOpts = {
  prompt: "Implement the layout protocol",
  repo: "renderer",
  mode: "code" as const,
  workspace: { type: "isolated-worktree" as const, baseRef: "main" },
  branch: "compat/layout",
};

describe("workflow durable sessions", () => {
  test("creates visible isolated siblings linked to the workflow parent", async () => {
    const h = harness({
      parent: {
        mcpServers: ["safe-tools"],
        model: "pi/anthropic/claude-sonnet-5",
        effort: "high",
        fastMode: true,
        accountId: "account-1",
      },
    });
    const a = await h.controller.spawn(foundationOpts, "request-a");
    const b = await h.controller.spawn(
      { ...foundationOpts, branch: "compat/text", prompt: "Implement Text" },
      "request-b",
    );

    expect(a.parentSessionId).toBe("parent");
    expect(b.parentSessionId).toBe("parent");
    expect((await h.controller.status(a.id)).worktreeDir).not.toBe(
      (await h.controller.status(b.id)).worktreeDir,
    );
    expect(h.creates[0]).toMatchObject({
      isolatedWorktree: true,
      baseRef: "main",
      parentSessionId: "parent",
      mcpServers: ["safe-tools"],
      model: "pi/anthropic/claude-sonnet-5",
      effort: "high",
      fastMode: true,
      accountId: "account-1",
      spawnDepth: 1,
    });
  });

  test("branches a dependent child from another child's pushed branch", async () => {
    const h = harness();
    const foundation = await h.controller.spawn(foundationOpts, "request-a");
    const dependent = await h.controller.spawn(
      {
        prompt: "Implement Text",
        repo: "renderer",
        mode: "code",
        workspace: {
          type: "isolated-worktree",
          baseSessionId: foundation.id,
        },
        branch: "compat/text",
      },
      "request-b",
    );

    expect(dependent.branch).toBe("compat/text");
    expect(h.creates[1]).toMatchObject({
      baseRef: "compat/layout",
      stackedOnBranch: "compat/layout",
      isolatedWorktree: true,
    });
  });

  test("rejects unpushed, uncommitted and cross-repository base sessions clearly", async () => {
    const unpushed = harness({ pushed: (session) => session.id === "parent" });
    const base = await unpushed.controller.spawn(foundationOpts, "request-a");
    await expect(
      unpushed.controller.spawn(
        {
          ...foundationOpts,
          branch: "compat/text",
          workspace: {
            type: "isolated-worktree",
            baseSessionId: base.id,
          },
        },
        "request-b",
      ),
    ).rejects.toThrow(/not pushed at its current commit/);

    const dirty = harness({ dirty: (session) => session.id !== "parent" });
    const dirtyBase = await dirty.controller.spawn(foundationOpts, "request-c");
    await expect(
      dirty.controller.spawn(
        {
          ...foundationOpts,
          branch: "compat/text",
          workspace: {
            type: "isolated-worktree",
            baseSessionId: dirtyBase.id,
          },
        },
        "request-d",
      ),
    ).rejects.toThrow(/has uncommitted changes/);

    const crossRepo = harness();
    const otherBase = await crossRepo.controller.spawn(
      { ...foundationOpts, repo: "other" },
      "request-e",
    );
    await expect(
      crossRepo.controller.spawn(
        {
          ...foundationOpts,
          workspace: {
            type: "isolated-worktree",
            baseSessionId: otherBase.id,
          },
        },
        "request-f",
      ),
    ).rejects.toThrow(/belongs to repo `other`/);
  });

  test("status, messaging, waiting and cancellation are child-scoped", async () => {
    const h = harness();
    const child = await h.controller.spawn(foundationOpts, "request-a");
    await h.controller.send(child.id, "Please open the PR", "send-a");
    expect(h.sends).toEqual([{ id: child.id, message: "Please open the PR" }]);
    h.sessions.set(child.id, {
      ...h.sessions.get(child.id)!,
      state: "idle",
      isRunning: false,
      claudeSessionId: "engine-child",
      prUrl: "https://github.com/tellahq/renderer/pull/1",
    });
    const opened = await h.controller.wait(
      child.id,
      { until: "pr_opened" },
      new AbortController().signal,
    );
    expect(opened.status).toBe("done");
    expect(opened.prUrl).toContain("/pull/1");
    expect((await h.controller.cancel(child.id, "cancel-a")).status).toBe(
      "cancelled",
    );
    expect(h.cancels).toEqual([child.id]);
    await expect(h.controller.status("parent")).rejects.toThrow(
      /not spawned by this workflow/,
    );
  });

  test("enforces nesting depth and registered parent repo scope", async () => {
    const deep = harness({ parent: { spawnDepth: 2 } });
    await expect(
      deep.controller.spawn(foundationOpts, "request-a"),
    ).rejects.toThrow(/depth 3 exceeds/);

    const h = harness();
    await expect(
      h.controller.spawn({ ...foundationOpts, repo: "forbidden" }, "request-b"),
    ).rejects.toThrow(/not registered on the workflow parent/);
  });

  test("automation policy fails closed instead of widening tools", async () => {
    const h = harness();
    const blocked = createWorkflowSessionController({
      parentSessionId: "parent",
      user: "Automation",
      allowSpawning: false,
      maxDepth: 2,
      deps: {
        control: {
          ...({} as SessionControl),
          getSession: (id) => h.sessions.get(id),
        },
      },
    });
    await expect(blocked.spawn(foundationOpts, "request-a")).rejects.toThrow(
      /unavailable in automation workflows/,
    );
  });
});
