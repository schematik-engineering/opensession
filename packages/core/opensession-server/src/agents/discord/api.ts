const API_BASE = "https://discord.com/api/v10";

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
  guild_id?: string;
}

export interface DiscordMessageResult {
  id: string;
  channel_id: string;
  content?: string;
}

export interface DiscordApplicationCommand {
  name: string;
  description: string;
  type: 1;
  dm_permission?: boolean;
  default_member_permissions?: string;
  options?: unknown[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorLabel(body: unknown): string {
  if (!body || typeof body !== "object") return "request rejected";
  const value = body as Record<string, unknown>;
  const code = typeof value.code === "number" ? ` code ${value.code}` : "";
  const message =
    typeof value.message === "string"
      ? value.message.slice(0, 240)
      : "request rejected";
  return `${message}${code}`;
}

export function splitDiscordMessage(text: string, limit = 1_900): string[] {
  const value = text.trim() || "(No text response.)";
  const chunks: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class DiscordRest {
  constructor(
    private readonly token: string,
    private readonly applicationId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          ...(auth ? { Authorization: `Bot ${this.token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "User-Agent": "OpenSession-Discord (https://opensession.com, 1)",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429) {
        const rate = (await response.json().catch(() => ({}))) as {
          retry_after?: number;
        };
        const retryMs = Math.max(
          250,
          Math.min((rate.retry_after || 1) * 1_000, 30_000),
        );
        await delay(retryMs);
        continue;
      }
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(
          `Discord API ${method} failed (${response.status}): ${errorLabel(detail)}`,
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    throw new Error(`Discord API ${method} remained rate limited`);
  }

  currentBot(): Promise<DiscordUser> {
    return this.request("GET", "/users/@me");
  }

  currentGuilds(): Promise<DiscordGuild[]> {
    return this.request("GET", "/users/@me/guilds");
  }

  gatewayBot(): Promise<{ url: string; shards: number }> {
    return this.request("GET", "/gateway/bot");
  }

  channel(id: string): Promise<DiscordChannel> {
    return this.request("GET", `/channels/${id}`);
  }

  async syncGuildCommand(
    guildId: string,
    command: DiscordApplicationCommand,
  ): Promise<unknown> {
    const base = `/applications/${this.applicationId}/guilds/${guildId}/commands`;
    const existing = await this.request<Array<Record<string, unknown>>>(
      "GET",
      base,
    );
    const match = existing.find(
      (candidate) =>
        candidate.name === command.name && candidate.type === command.type,
    );
    if (!match) return this.request("POST", base, command);
    const comparable = {
      name: match.name,
      description: match.description,
      type: match.type,
      dm_permission: match.dm_permission,
      default_member_permissions: match.default_member_permissions,
      options: match.options || [],
    };
    const wanted = { ...command, options: command.options || [] };
    if (JSON.stringify(comparable) === JSON.stringify(wanted)) return match;
    return this.request("PATCH", `${base}/${match.id}`, command);
  }

  sendMessage(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Promise<DiscordMessageResult> {
    return this.request("POST", `/channels/${channelId}/messages`, {
      content: content.slice(0, 2_000),
      allowed_mentions: { parse: [], replied_user: false },
      ...(replyTo
        ? {
            message_reference: {
              message_id: replyTo,
              channel_id: channelId,
              fail_if_not_exists: false,
            },
          }
        : {}),
    });
  }

  editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<DiscordMessageResult> {
    return this.request(
      "PATCH",
      `/channels/${channelId}/messages/${messageId}`,
      {
        content: content.slice(0, 2_000),
        allowed_mentions: { parse: [] },
      },
    );
  }

  triggerTyping(channelId: string): Promise<void> {
    return this.request("POST", `/channels/${channelId}/typing`);
  }

  startThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<DiscordChannel> {
    return this.request(
      "POST",
      `/channels/${channelId}/messages/${messageId}/threads`,
      { name: name.slice(0, 100), auto_archive_duration: 1_440 },
    );
  }

  interactionCallback(
    interactionId: string,
    interactionToken: string,
    payload: unknown,
  ): Promise<void> {
    return this.request(
      "POST",
      `/interactions/${interactionId}/${interactionToken}/callback`,
      payload,
      false,
    );
  }

  editOriginalInteraction(
    interactionToken: string,
    content: string,
  ): Promise<DiscordMessageResult> {
    return this.request(
      "PATCH",
      `/webhooks/${this.applicationId}/${interactionToken}/messages/@original`,
      { content: content.slice(0, 2_000), allowed_mentions: { parse: [] } },
      false,
    );
  }

  followupInteraction(
    interactionToken: string,
    content: string,
  ): Promise<DiscordMessageResult> {
    return this.request(
      "POST",
      `/webhooks/${this.applicationId}/${interactionToken}`,
      { content: content.slice(0, 2_000), allowed_mentions: { parse: [] } },
      false,
    );
  }
}
