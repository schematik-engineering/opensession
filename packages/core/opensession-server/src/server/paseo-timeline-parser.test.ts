import { describe, expect, test } from "bun:test";
import { parsePaseoLinesAsync } from "./paseo-timeline-parser";

const timestamp = "2026-09-02T08:00:00.000Z";

function row(
  seqStart: number,
  item: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "paseo_timeline",
    agentId: "agent-123",
    provider: "opencode",
    timestamp,
    seqStart,
    seqEnd: seqStart,
    item,
    ...overrides,
  });
}

describe("Paseo timeline parsing", () => {
  test("maps messages, reasoning, and activity rows", async () => {
    const entries = await parsePaseoLinesAsync([
      row(1, { type: "user_message", text: "Ship this" }),
      row(2, { type: "reasoning", text: "Checking the tests" }),
      row(3, { type: "assistant_message", text: "Done" }),
      row(4, {
        type: "todo",
        items: [{ text: "Run tests", status: "completed" }],
      }),
      row(5, { type: "error", message: "Provider disconnected" }),
      row(6, { type: "compaction", status: "completed" }),
      row(7, { type: "compaction", status: "loading" }),
    ]);

    expect(entries.map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
      "assistant",
      "system",
      "system",
      "system",
    ]);
    expect(entries[1]).toMatchObject({
      content: "Checking the tests",
      isReasoning: true,
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "paseo-agent-123-1-1-user",
      "paseo-agent-123-2-2-reasoning",
      "paseo-agent-123-3-3-assistant",
      "paseo-agent-123-4-4-todo",
      "paseo-agent-123-5-5-error",
      "paseo-agent-123-6-6-compaction",
    ]);
  });

  test("splits completed and failed tool calls into paired entries", async () => {
    const entries = await parsePaseoLinesAsync([
      row(10, {
        type: "tool_call",
        callId: "call-shell",
        name: "Bash",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command: "bun test",
          cwd: "/repo",
          output: "2 pass",
          exitCode: 0,
        },
      }),
      row(11, {
        type: "tool_call",
        callId: "call-fetch",
        name: "Fetch",
        status: "failed",
        error: { message: "offline" },
        detail: {
          type: "fetch",
          url: "https://example.test",
          result: "request failed",
        },
      }),
      row(12, {
        type: "tool_call",
        callId: "call-live",
        name: "Search",
        status: "running",
        error: null,
        detail: { type: "search", query: "Paseo" },
      }),
    ]);

    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({
      id: "paseo-agent-123-10-10-tool-use",
      type: "tool_use",
      toolName: "Bash",
      toolUseId: "call-shell",
      toolInput: { command: "bun test", cwd: "/repo" },
    });
    expect(entries[1]).toMatchObject({
      type: "tool_result",
      content: "2 pass",
      toolUseId: "call-shell",
    });
    expect(entries[3]).toMatchObject({
      type: "tool_result",
      isError: true,
      toolUseId: "call-fetch",
    });
    expect(entries[3]?.content).toContain("offline");
    expect(entries[4]).toMatchObject({
      type: "tool_use",
      toolUseId: "call-live",
    });
  });

  test("skips malformed and future rows without losing valid rows", async () => {
    const entries = await parsePaseoLinesAsync([
      "not json",
      row(1, { type: "future_item", text: "unknown" }),
      row(
        2,
        { type: "user_message", text: "missing timestamp" },
        { timestamp: null },
      ),
      row(3, { type: "user_message", text: "Keep me" }),
    ]);

    expect(entries).toEqual([
      {
        id: "paseo-agent-123-3-3-user",
        type: "user",
        content: "Keep me",
        timestamp,
      },
    ]);
  });
});
