type CommandResultRecord = Record<string, unknown>;

/**
 * Mark duplicate create results so a reconnected browser can retire its durable
 * command without presenting the historical result as a brand-new session.
 * Other command results keep their existing wire shape.
 */
export function replayedSessionCreatedResult(
  id: string,
  workspaceId?: string | null,
): Record<string, unknown> {
  return {
    type: "session_created",
    id,
    ...(workspaceId ? { workspaceId } : {}),
    replayed: true,
  };
}

export function markReplayedCommandResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result as CommandResultRecord).type !== "session_created"
  )
    return result;
  return { ...(result as CommandResultRecord), replayed: true };
}

/** Retire the browser's durable create command exactly when the create wire
 * response becomes terminal. Without this receipt the client reconnect loop
 * keeps replaying the same failed create forever. */
export function terminalCreateCommandResult(
  frame: Record<string, unknown>,
  requestId: string,
): Record<string, unknown> | undefined {
  const outcome = frame.type;
  if (outcome !== "session_created" && outcome !== "error") return undefined;
  return {
    type: "command_result",
    sessionId:
      typeof frame.id === "string"
        ? frame.id
        : typeof frame.sessionId === "string"
          ? frame.sessionId
          : requestId,
    requestId,
    status: outcome === "session_created" ? "completed" : "failed",
    ...(outcome === "session_created"
      ? { result: frame }
      : {
          error: String(frame.message || "Session creation failed"),
          terminal: true,
        }),
  };
}
