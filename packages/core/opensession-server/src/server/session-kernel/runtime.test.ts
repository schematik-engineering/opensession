import { describe, expect, test } from "bun:test";
import { reconcileSessionKernelOwnership } from "./runtime";

describe("session kernel ownership boot reconciliation", () => {
  test("skips a permanent tombstone before querying or settling its stale projection", async () => {
    const quarantineQueries: string[] = [];
    const settlements: Array<{ sessionId: string; previousState: string }> = [];

    const settled = await reconcileSessionKernelOwnership(
      new Set(["owned-session"]),
      {
        runStateProjections: () => [
          {
            sessionId: "deleted-session",
            state: "running",
            since: "2026-08-28T18:00:00.000Z",
            generation: 1,
            changeSeq: 1,
          },
          {
            sessionId: "owned-session",
            state: "running",
            since: "2026-08-28T18:00:00.000Z",
            generation: 1,
            changeSeq: 1,
          },
          {
            sessionId: "quarantined-session",
            state: "interrupted",
            since: "2026-08-28T18:00:00.000Z",
            generation: 2,
            changeSeq: 2,
          },
          {
            sessionId: "orphan-session",
            state: "starting",
            since: "2026-08-28T18:00:00.000Z",
            generation: 3,
            changeSeq: 3,
          },
          {
            sessionId: "idle-session",
            state: "idle",
            since: "2026-08-28T18:00:00.000Z",
            generation: 0,
            changeSeq: 0,
          },
        ],
        isTombstoned: async (sessionId) => sessionId === "deleted-session",
        isQuarantined: async (sessionId) => {
          quarantineQueries.push(sessionId);
          return sessionId === "quarantined-session";
        },
        settleMissingOwner: async (sessionId, previousState) => {
          settlements.push({ sessionId, previousState });
        },
      },
    );

    expect(quarantineQueries).toEqual([
      "quarantined-session",
      "orphan-session",
    ]);
    expect(settlements).toEqual([
      { sessionId: "orphan-session", previousState: "starting" },
    ]);
    expect(settled).toEqual(["orphan-session"]);
  });
});
