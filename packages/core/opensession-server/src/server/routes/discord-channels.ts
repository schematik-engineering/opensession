import { DiscordRest } from "../../agents/discord/api";
import {
  loadDiscordConfig,
  type DiscordConfig,
} from "../../agents/discord/config";
import type { RouteContext } from "./context";

export interface DiscordChannelOption {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
}

type DiscordChannelReader = Pick<
  DiscordRest,
  "currentGuilds" | "guildChannels"
>;

export function defaultDiscordChannel(
  channels: DiscordChannelOption[],
): string | undefined {
  return (
    channels.find((channel) => channel.name.toLowerCase() === "general")?.id ||
    channels[0]?.id
  );
}

export async function discordChannelsPayload(
  config: DiscordConfig,
  rest: DiscordChannelReader,
): Promise<{
  channels: DiscordChannelOption[];
  defaultChannel?: string;
}> {
  const guilds = (await rest.currentGuilds()).filter((guild) =>
    config.guildIds.includes(guild.id),
  );
  const channelGroups = await Promise.all(
    guilds.map(async (guild) => ({
      guild,
      channels: await rest.guildChannels(guild.id),
    })),
  );
  const channels = channelGroups
    .flatMap(({ guild, channels: guildChannels }) =>
      guildChannels.flatMap((channel) => {
        if (
          (channel.type !== 0 && channel.type !== 5) ||
          !channel.name ||
          (config.channelIds.length > 0 &&
            !config.channelIds.includes(channel.id))
        )
          return [];
        return [
          {
            id: channel.id,
            name: channel.name,
            guildId: guild.id,
            guildName: guild.name,
          },
        ];
      }),
    )
    .toSorted(
      (left, right) =>
        left.guildName.localeCompare(right.guildName) ||
        left.name.localeCompare(right.name),
    );
  return { channels, defaultChannel: defaultDiscordChannel(channels) };
}

export async function handleDiscordChannelRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (ctx.path !== "/api/discord/channels" || ctx.req.method !== "GET")
    return undefined;

  try {
    const config = loadDiscordConfig();
    return Response.json(
      await discordChannelsPayload(
        config,
        new DiscordRest(config.token, config.applicationId),
      ),
    );
  } catch {
    return Response.json(
      {
        error:
          "Discord channels are unavailable. Check the Discord integration setup.",
      },
      { status: 503 },
    );
  }
}
