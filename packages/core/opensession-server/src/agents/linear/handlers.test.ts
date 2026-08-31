import { afterEach, describe, expect, test } from "bun:test";
import { handleAgentSession, type AgentSessionWebhook } from "./handlers";
import {
  activeSessions,
  adoptActiveSessionIdentity,
  processedSessions,
  type ActiveSession,
} from "./session";

afterEach(() => {
  activeSessions.clear();
  processedSessions.clear();
});

function created(id: string): AgentSessionWebhook {
  return {
    type: "AgentSession",
    action: "created",
    organizationId: "org-without-grant",
    agentSession: {
      id,
      status: "pending",
      issue: {
        id: "issue-1",
        identifier: "SMT-1",
        title: "Test assignment",
        url: "https://linear.app/example/issue/SMT-1",
      },
    },
  };
}

describe("Linear assignment intake", () => {
  test("rebinds a restarted issue session to the newest Linear id without a duplicate", () => {
    const abortController = new AbortController();
    activeSessions.set("old-linear-id", {
      branch: "check-smt-1",
      repoId: "opensession",
      claudeSessionId: "engine-session",
      accessToken: "test",
      issueTitle: "Test assignment",
      issueIdentifier: "SMT-1",
      issueId: "issue-1",
      issueDescription: "",
      issueUrl: "https://linear.app/example/issue/SMT-1",
      teamId: "team-1",
      worktreeDir: "/tmp/check-smt-1",
      linearSessionId: "old-linear-id",
      phase: "working",
      planningConversation: [],
      participants: [],
      lastActiveUser: null,
      issueCreator: null,
      abortController,
    } satisfies ActiveSession);

    const adopted = adoptActiveSessionIdentity(
      "new-linear-id",
      "issue-1",
      "SMT-1",
    );
    expect(adopted?.previousIds).toEqual(["old-linear-id"]);
    expect(abortController.signal.aborted).toBe(true);
    expect(activeSessions.size).toBe(1);
    expect(activeSessions.has("old-linear-id")).toBe(false);
    expect(activeSessions.get("new-linear-id")?.linearSessionId).toBe(
      "new-linear-id",
    );
  });

  test("missing OAuth is retryable and does not poison created-session dedup", async () => {
    const first = await handleAgentSession(created("agent-session-1"), {});
    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("30");
    expect(processedSessions.has("agent-session-1")).toBe(false);
    expect(activeSessions.has("agent-session-1")).toBe(false);

    const retry = await handleAgentSession(created("agent-session-1"), {});
    expect(retry.status).toBe(503);
    expect(processedSessions.has("agent-session-1")).toBe(false);
  });
});
