import { afterEach, describe, expect, test } from "bun:test";
import { handleAgentSession, type AgentSessionWebhook } from "./handlers";
import { activeSessions, processedSessions } from "./session";

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
