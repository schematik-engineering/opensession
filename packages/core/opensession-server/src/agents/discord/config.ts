import { existsSync, readFileSync, statSync } from "fs";
import { configuredIntegration } from "../../server/config";
import { stateDir } from "../../server/paths";

export interface DiscordConfig {
  applicationId: string;
  publicKey?: string;
  tokenFile: string;
  token: string;
  guildIds: string[];
  channelIds: string[];
  userIds: string[];
  defaultModel?: string;
  sandbox: "docker";
  responseTimeoutMs: number;
}

const SNOWFLAKE = /^\d{15,22}$/;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listValue(envName: string, value: unknown): string[] {
  const raw = process.env[envName] ?? value;
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,]+/)
      : [];
  return [
    ...new Set(
      items
        .map((item) => String(item).trim())
        .filter((item) => SNOWFLAKE.test(item)),
    ),
  ];
}

function boundedMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(30_000, Math.min(parsed, 60 * 60_000))
    : fallback;
}

/**
 * Resolve Discord's bot configuration at startup, never at import time.
 * Production should use the token file. The env token exists only for
 * container/secret-manager deployments that cannot project a file.
 */
export function loadDiscordConfig(): DiscordConfig {
  const cfg = configuredIntegration("discord");
  const applicationId =
    stringValue(process.env.DISCORD_APPLICATION_ID) ||
    stringValue(cfg.applicationId) ||
    "";
  if (!SNOWFLAKE.test(applicationId)) {
    throw new Error("DISCORD_APPLICATION_ID must be a Discord snowflake");
  }

  const tokenFile =
    stringValue(process.env.DISCORD_BOT_TOKEN_FILE) ||
    stringValue(cfg.botTokenFile) ||
    stateDir("discord/bot-token");
  const tokenFromEnv = stringValue(process.env.DISCORD_BOT_TOKEN);
  if (!tokenFromEnv && existsSync(tokenFile)) {
    const metadata = statSync(tokenFile);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error(
        `Discord bot token file ${tokenFile} must be a private regular file (mode 0600 or stricter)`,
      );
    }
  }
  const token = tokenFromEnv
    ? tokenFromEnv
    : existsSync(tokenFile)
      ? readFileSync(tokenFile, "utf8").trim()
      : "";
  if (!token) {
    throw new Error(
      `Discord bot token is missing (write ${tokenFile} mode 0600 or set DISCORD_BOT_TOKEN)`,
    );
  }

  const guildIds = listValue("DISCORD_GUILD_IDS", cfg.guildIds);
  if (!guildIds.length) {
    throw new Error(
      "DISCORD_GUILD_IDS is required; the Discord agent fails closed without an explicit guild allowlist",
    );
  }

  const configuredSandbox =
    stringValue(process.env.DISCORD_SANDBOX) || stringValue(cfg.sandbox);
  if (configuredSandbox && configuredSandbox !== "docker") {
    throw new Error("Discord sessions currently require the docker sandbox");
  }

  return {
    applicationId,
    publicKey:
      stringValue(process.env.DISCORD_PUBLIC_KEY) || stringValue(cfg.publicKey),
    tokenFile,
    token,
    guildIds,
    channelIds: listValue("DISCORD_CHANNEL_IDS", cfg.channelIds),
    userIds: listValue("DISCORD_USER_IDS", cfg.userIds),
    defaultModel:
      stringValue(process.env.DISCORD_DEFAULT_MODEL) ||
      stringValue(cfg.defaultModel),
    sandbox: "docker",
    responseTimeoutMs: boundedMs(
      process.env.DISCORD_RESPONSE_TIMEOUT_MS ?? cfg.responseTimeoutMs,
      30 * 60_000,
    ),
  };
}

export function discordTokenSourceHealth(config: DiscordConfig): {
  source: "file" | "environment";
} {
  void config;
  return process.env.DISCORD_BOT_TOKEN
    ? { source: "environment" }
    : { source: "file" };
}
