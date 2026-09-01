import { describe, expect, test } from "bun:test";
import type { SessionDiscordShare } from "../types";
import { appendDiscordShare } from "./shipped-changes";

function share(
  overrides: Partial<SessionDiscordShare> = {},
): SessionDiscordShare {
  return {
    channelId: "1542925450790305912",
    channelName: "general",
    guildId: "1542925450790305904",
    guildName: "Schematik",
    permalink:
      "https://discord.com/channels/1542925450790305904/1542925450790305912/message-1",
    messageId: "message-1",
    at: "2026-09-01T10:00:00.000Z",
    prNumber: 50,
    announcementKey: "example/repo#50:abc",
    ...overrides,
  };
}

describe("Discord shipped-change session receipts", () => {
  test("reconstructs a missing session receipt", () => {
    expect(appendDiscordShare(undefined, share())).toEqual([share()]);
  });

  test("does not duplicate a reconstructed Discord delivery", () => {
    const original = share({ by: "Alex" });
    const recovered = share({ by: "A retry" });

    expect(appendDiscordShare([original], recovered)).toEqual([original]);
  });
});
