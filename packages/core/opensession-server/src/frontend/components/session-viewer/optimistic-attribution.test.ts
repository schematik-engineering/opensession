import { expect, test } from "bun:test";
import { deriveSessionQueue } from "../../lib/session-queue";

test("optimistic prompts keep their sender instead of borrowing the session owner", () => {
  const sentAt = Date.parse("2026-08-28T12:00:00.000Z");
  const result = deriveSessionQueue({
    queued: [],
    steered: [],
    pending: [
      {
        id: "pending-prompt",
        content: "Please continue",
        user: "Jack",
        sentAt,
        transcriptAfterEntryId: null,
        busyMode: "steer",
      },
    ],
    pendingDeliveryIds: [],
    outboxItems: [],
    landedOutboxIds: new Set(),
    entries: [],
    settingUpWorkspace: false,
    now: sentAt,
  });

  expect(result.optimisticTranscriptEntries).toMatchObject([
    { id: "pending-prompt", sender: "Jack" },
  ]);
});
