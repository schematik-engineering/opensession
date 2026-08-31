import { describe, expect, test } from "bun:test";
import type { DiscordConfig } from "../../agents/discord/config";
import {
  defaultDiscordChannel,
  discordChannelsPayload,
} from "./discord-channels";

const config = {
  applicationId: "1542925450790305903",
  tokenFile: "/tmp/unused-discord-token",
  token: "test-token",
  guildIds: ["1542925450790305904"],
  channelIds: [],
  roleIds: [],
  userIds: [],
  sandbox: "docker",
  responseTimeoutMs: 30_000,
} satisfies DiscordConfig;

describe("Discord channel selection", () => {
  test("lists text channels from allowed guilds and prefers general", async () => {
    const payload = await discordChannelsPayload(config, {
      currentGuilds: async () => [
        { id: "1542925450790305904", name: "Schematik" },
        { id: "1542925450790305999", name: "Other" },
      ],
      guildChannels: async (guildId) =>
        guildId === "1542925450790305904"
          ? [
              { id: "1542925450790305911", type: 4, name: "Projects" },
              { id: "1542925450790305912", type: 0, name: "alerts" },
              { id: "1542925450790305913", type: 0, name: "general" },
            ]
          : [],
    });

    expect(payload).toEqual({
      channels: [
        {
          id: "1542925450790305912",
          name: "alerts",
          guildId: "1542925450790305904",
          guildName: "Schematik",
        },
        {
          id: "1542925450790305913",
          name: "general",
          guildId: "1542925450790305904",
          guildName: "Schematik",
        },
      ],
      defaultChannel: "1542925450790305913",
    });
  });

  test("honors the configured channel allowlist", async () => {
    const payload = await discordChannelsPayload(
      { ...config, channelIds: ["1542925450790305912"] },
      {
        currentGuilds: async () => [
          { id: "1542925450790305904", name: "Schematik" },
        ],
        guildChannels: async () => [
          { id: "1542925450790305912", type: 0, name: "alerts" },
          { id: "1542925450790305913", type: 0, name: "general" },
        ],
      },
    );

    expect(payload.channels.map((channel) => channel.id)).toEqual([
      "1542925450790305912",
    ]);
    expect(defaultDiscordChannel(payload.channels)).toBe("1542925450790305912");
  });
});
