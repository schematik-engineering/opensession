import { describe, expect, test } from "bun:test";
import {
  markReplayedCommandResult,
  replayedSessionCreatedResult,
  terminalCreateCommandResult,
} from "./command-replay";

describe("replayedSessionCreatedResult", () => {
  test("builds the replay response for a previously completed create", () => {
    expect(replayedSessionCreatedResult("os-old", "ws-old")).toEqual({
      type: "session_created",
      id: "os-old",
      workspaceId: "ws-old",
      replayed: true,
    });
    expect(replayedSessionCreatedResult("os-old")).toEqual({
      type: "session_created",
      id: "os-old",
      replayed: true,
    });
  });
});

describe("markReplayedCommandResult", () => {
  test("marks a duplicate session create result", () => {
    expect(
      markReplayedCommandResult({
        type: "session_created",
        id: "os-old",
        workspaceId: "ws-old",
      }),
    ).toEqual({
      type: "session_created",
      id: "os-old",
      workspaceId: "ws-old",
      replayed: true,
    });
  });

  test("leaves other stored command results unchanged", () => {
    const result = { status: "queued" };
    expect(markReplayedCommandResult(result)).toBe(result);
    expect(markReplayedCommandResult(undefined)).toBeUndefined();
  });
});

describe("terminalCreateCommandResult", () => {
  test("completes a successful create receipt", () => {
    const frame = { type: "session_created", id: "os-new" };
    expect(terminalCreateCommandResult(frame, "request-new")).toEqual({
      type: "command_result",
      sessionId: "os-new",
      requestId: "request-new",
      status: "completed",
      result: frame,
    });
  });

  test("terminally fails a rejected create receipt", () => {
    expect(
      terminalCreateCommandResult(
        {
          type: "error",
          sessionId: "os-failed",
          message: "Workspace setup failed",
        },
        "request-failed",
      ),
    ).toEqual({
      type: "command_result",
      sessionId: "os-failed",
      requestId: "request-failed",
      status: "failed",
      error: "Workspace setup failed",
      terminal: true,
    });
  });

  test("does not settle a non-terminal create frame", () => {
    expect(
      terminalCreateCommandResult({ type: "text_chunk" }, "request-live"),
    ).toBeUndefined();
  });
});
