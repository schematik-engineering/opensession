import {
  forgetShippedChangeAnnouncement,
  shareShippedVisualChange,
} from "../../agents/github/shipped-change-notify";
import { DiscordRest } from "../../agents/discord/api";
import { loadDiscordConfig } from "../../agents/discord/config";
import { deleteSlackMessage } from "../../agents/slack/slack-api";
import { findSessionAsync, updateSessionFile } from "../session-cache";
import type { SessionDiscordShare } from "../types";
import { resolvePrTarget } from "../session-repos";
import { prHostFor } from "../pr-host";
import { getRepo } from "../worktree";
import { discordChannelsPayload } from "./discord-channels";
import { requestUser, type RouteContext } from "./context";

async function discordDestination() {
  const config = loadDiscordConfig();
  const discord = new DiscordRest(config.token, config.applicationId);
  const payload = await discordChannelsPayload(config, discord);
  return { discord, ...payload };
}

export function appendDiscordShare(
  current: readonly SessionDiscordShare[] | undefined,
  share: SessionDiscordShare,
): SessionDiscordShare[] {
  const shares = current || [];
  return shares.some((candidate) => candidate.messageId === share.messageId)
    ? [...shares]
    : [...shares, share].slice(-20);
}

export async function handleShippedChangeRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  const match = path.match(/^\/api\/sessions\/([^/]+)\/share-shipped-change$/);
  if (
    !match ||
    (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT")
  )
    return;
  const session = await findSessionAsync(decodeURIComponent(match[1]));
  if (!session)
    return Response.json({ error: "Session not found" }, { status: 404 });
  if (req.method === "GET") {
    try {
      const { channels, defaultChannel } = await discordDestination();
      return Response.json({
        channels: channels.map(({ id, name }) => ({ id, name })),
        defaultChannel,
        canUploadImages: true,
      });
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

  const body = await req.json().catch(() => ({}));
  const caller =
    ctx.authUser?.login || ctx.authUser?.name || requestUser(ctx, body?.user);

  // PUT is undo. New receipts belong to Discord; the Slack fallback keeps old
  // persisted receipts removable after upgrading this card.
  if (req.method === "PUT") {
    const at = typeof body?.at === "string" ? body.at : "";
    const discordShare = session.discordShares?.find(
      (candidate) => candidate.at === at,
    );
    if (discordShare) {
      try {
        const config = loadDiscordConfig();
        await new DiscordRest(config.token, config.applicationId).deleteMessage(
          discordShare.channelId,
          discordShare.messageId,
        );
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Couldn't undo the Discord message",
          },
          { status: 502 },
        );
      }
      if (discordShare.announcementKey)
        forgetShippedChangeAnnouncement(discordShare.announcementKey);
      await updateSessionFile(session.id, (data) => ({
        ...data,
        discordShares: (data.discordShares || []).filter(
          (candidate) => candidate.at !== at,
        ),
      }));
      return Response.json({ status: "undone" });
    }

    const slackShare = session.slackShares?.find(
      (candidate) => candidate.at === at,
    );
    if (!slackShare?.ts)
      return Response.json(
        { error: "That message can no longer be undone" },
        { status: 409 },
      );
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const slackToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
    if (!slackToken)
      return Response.json(
        { error: "Connect your Slack account in Settings → Account" },
        { status: 403 },
      );
    try {
      await deleteSlackMessage(slackShare.channelId, slackShare.ts, slackToken);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Couldn't undo the Slack message",
        },
        { status: 502 },
      );
    }
    if (slackShare.announcementKey)
      forgetShippedChangeAnnouncement(slackShare.announcementKey);
    await updateSessionFile(session.id, (data) => ({
      ...data,
      slackShares: (data.slackShares || []).filter(
        (candidate) => candidate.at !== at,
      ),
    }));
    return Response.json({ status: "undone" });
  }

  const target = resolvePrTarget(session, body?.repo, body?.branch);
  if (!target)
    return Response.json(
      { error: "Pull request target not found" },
      { status: 404 },
    );
  const repo = getRepo(target.repoId);
  const pr = await prHostFor(repo).getPrDetails(target.branch, target.ghRepo);
  if (!pr)
    return Response.json({ error: "Pull request not found" }, { status: 404 });
  if (pr.state !== "MERGED")
    return Response.json(
      { error: "Send to Discord is available after the pull request merges" },
      { status: 409 },
    );

  try {
    const { discord, channels, defaultChannel } = await discordDestination();
    const requestedChannel =
      typeof body?.channel === "string" && body.channel
        ? body.channel
        : defaultChannel;
    const channel = channels.find(
      (candidate) => candidate.id === requestedChannel,
    );
    if (!channel) throw new Error("Choose a configured Discord channel");
    const result = await shareShippedVisualChange({
      session,
      pr: { number: pr.number, title: pr.title, url: pr.url },
      repoFullName: target.ghRepo,
      requestedBy: caller,
      channel,
      message: body?.message,
      screenshots: Array.isArray(body?.screenshots)
        ? body.screenshots.filter(
            (path: unknown): path is string => typeof path === "string",
          )
        : undefined,
      discord,
    });
    const share: SessionDiscordShare | undefined =
      "channel" in result
        ? {
            channelId: result.channel.id,
            channelName: result.channel.name,
            guildId: result.channel.guildId,
            guildName: result.channel.guildName,
            permalink: result.permalink,
            messageId: result.messageId,
            at: result.at,
            by: result.requestedBy,
            prNumber: result.prNumber,
            announcementKey: result.announcementKey,
          }
        : undefined;
    if (share) {
      await updateSessionFile(session.id, (data) => ({
        ...data,
        discordShares: appendDiscordShare(data.discordShares, share),
      }));
    }
    return Response.json({ ...result, share });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Couldn't share the shipped update",
      },
      { status: 502 },
    );
  }
}
