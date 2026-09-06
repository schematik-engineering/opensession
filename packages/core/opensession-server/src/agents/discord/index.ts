import type { AgentModule } from "../types";
import type {
  PendingQuestionView,
  SessionControl,
  SessionSummary,
} from "../../server/session-control";
import { getSessionControl } from "../../server/session-control";
import { configuredServer } from "../../server/config";
import { resolveModel } from "../../server/models";
import type { TranscriptEntry } from "../../server/types";
import {
  DiscordRest,
  splitDiscordMessage,
  type DiscordApplicationCommand,
  type DiscordChannel,
  type DiscordUser,
} from "./api";
import {
  discordTokenSourceHealth,
  loadDiscordConfig,
  type DiscordConfig,
} from "./config";
import { DiscordGateway } from "./gateway";
import { DiscordStateStore } from "./state";

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
// MESSAGE_CONTENT must also be enabled in Discord's Developer Portal.
export const DISCORD_GATEWAY_INTENTS = 1 | 512 | 4_096 | 32_768;

type DiscordAttachment = {
  id: string;
  filename: string;
  url: string;
  content_type?: string;
  size?: number;
};

type DiscordEmbed = {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  fields?: Array<{ name?: string; value?: string }>;
};

type DiscordMessageReference = {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
};

type DiscordMessage = {
  id: string;
  type?: number;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: DiscordUser;
  member?: { roles?: string[] };
  mentions?: DiscordUser[];
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbed[];
  message_reference?: DiscordMessageReference;
  referenced_message?: DiscordMessage | null;
  timestamp?: string;
};

type InteractionOption = {
  name: string;
  type: number;
  value?: string;
  options?: InteractionOption[];
};

type DiscordInteraction = {
  id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser; roles?: string[] };
  user?: DiscordUser;
  data?: { name?: string; options?: InteractionOption[] };
};

type DiscordAgentDependencies = {
  loadConfig?: () => DiscordConfig;
  state?: DiscordStateStore;
  control?: () => SessionControl;
  rest?: (config: DiscordConfig) => DiscordRest;
  gateway?: (
    options: ConstructorParameters<typeof DiscordGateway>[0],
  ) => DiscordGateway;
};

const MODEL_CHOICES = [
  { name: "Grok 4.6", value: "grok/grok-4.6" },
  { name: "Grok 4.5", value: "grok/grok-4.5" },
  { name: "Cursor Auto", value: "cursor/auto" },
  { name: "Cursor Grok 4.6", value: "cursor/grok-4.6" },
  { name: "Cursor Composer 2.5", value: "cursor/composer-2.5" },
  { name: "Cursor Claude Opus 5", value: "cursor/claude-opus-5" },
  { name: "Cursor GPT 5.6", value: "cursor/gpt-5.6-sol" },
];

export const DISCORD_COMMANDS: DiscordApplicationCommand[] = [
  {
    name: "os",
    description: "Work with OpenSession",
    type: 1,
    dm_permission: false,
    default_member_permissions: "2048",
    options: [
      {
        type: 1,
        name: "ask",
        description: "Ask or continue the OpenSession linked to this channel",
        options: [
          {
            type: 3,
            name: "prompt",
            description: "What OpenSession should do",
            required: true,
            max_length: 4_000,
          },
        ],
      },
      {
        type: 1,
        name: "model",
        description: "Set the model for this channel's session",
        options: [
          {
            type: 3,
            name: "model",
            description: "Subscription-backed provider/model",
            required: true,
            choices: MODEL_CHOICES,
          },
        ],
      },
      {
        type: 1,
        name: "status",
        description: "Show this channel's linked OpenSession",
      },
      {
        type: 1,
        name: "stop",
        description: "Stop the active run in this channel's OpenSession",
      },
      {
        type: 1,
        name: "new",
        description: "Start a fresh OpenSession on the next prompt",
      },
    ],
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayName(user: DiscordUser): string {
  return user.global_name?.trim() || user.username || `Discord ${user.id}`;
}

function conversationKey(
  guildId: string | undefined,
  channelId: string,
): string {
  return guildId ? `guild:${guildId}:channel:${channelId}` : `dm:${channelId}`;
}

function commandParts(interaction: DiscordInteraction): {
  subcommand: string;
  values: Record<string, string>;
} {
  const command = interaction.data?.options?.[0];
  const values: Record<string, string> = {};
  for (const option of command?.options || []) {
    if (typeof option.value === "string") values[option.name] = option.value;
  }
  return { subcommand: command?.name || "status", values };
}

function describeQuestion(question: PendingQuestionView): string {
  const rows = (
    Array.isArray(question.questions) ? question.questions : []
  ).map((raw, index) => {
    const value =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const header =
      typeof value.header === "string" && value.header.trim()
        ? value.header.trim()
        : `Question ${index + 1}`;
    const text =
      typeof value.question === "string" ? value.question : "Choose an answer";
    const options = Array.isArray(value.options)
      ? value.options
          .map((option) =>
            option &&
            typeof option === "object" &&
            typeof (option as Record<string, unknown>).label === "string"
              ? `• ${(option as Record<string, unknown>).label}`
              : "",
          )
          .filter(Boolean)
          .join("\n")
      : "";
    return `**${header}** — ${text}${options ? `\n${options}` : ""}`;
  });
  return `OpenSession needs your input:\n\n${rows.join("\n\n")}\n\nReply in this thread to continue.`;
}

function answerMap(
  question: PendingQuestionView,
  text: string,
): Record<string, string> {
  const questions = Array.isArray(question.questions) ? question.questions : [];
  if (questions.length <= 1) {
    const raw = questions[0];
    const header =
      raw &&
      typeof raw === "object" &&
      typeof (raw as Record<string, unknown>).header === "string"
        ? String((raw as Record<string, unknown>).header)
        : "Answer";
    return { [header]: text.trim() };
  }
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0 && line.slice(separator + 1).trim()) {
      parsed[line.slice(0, separator).trim()] = line
        .slice(separator + 1)
        .trim();
    }
  }
  return parsed;
}

function latestAssistant(
  entries: TranscriptEntry[],
  baseline: Set<string>,
): string | null {
  const fresh = entries.filter((entry) => !baseline.has(entry.id));
  let lastUser = -1;
  fresh.forEach((entry, index) => {
    if (entry.type === "user") lastUser = index;
  });
  const answers = fresh
    .slice(lastUser + 1)
    .filter(
      (entry) =>
        entry.type === "assistant" &&
        !entry.isReasoning &&
        entry.content.trim(),
    )
    .map((entry) => entry.content.trim());
  return answers.length ? answers.join("\n\n") : null;
}

function sessionLink(id: string): string {
  return `${configuredServer().publicBaseUrl.replace(/\/$/, "")}/session/${encodeURIComponent(id)}`;
}

export function safeError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}/g,
      "[redacted]",
    )
    .replace(/\s+body_preview=.*/s, "")
    .trim();
  if (
    /\b429\b|rate limit|requests too quickly|resource has been exhausted/i.test(
      message,
    )
  ) {
    return "The selected model is rate limited. This Discord thread is still linked to the same OpenSession. Try again shortly or use `/os model`.";
  }
  return message.replace(/\s+/g, " ").slice(0, 600);
}

function retryableError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { retryable?: unknown }).retryable === true
  );
}

function messageNonce(eventId: string, part: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${eventId}:${part}`)
    .digest("hex")
    .slice(0, 25);
}

export class DiscordAgent implements AgentModule {
  name = "discord";
  private config?: DiscordConfig;
  private rest?: DiscordRest;
  private gateway?: DiscordGateway;
  private state: DiscordStateStore;
  private bot?: DiscordUser;
  private guildNames: Record<string, string> = {};
  private channelCache = new Map<string, DiscordChannel>();
  private inflightEvents = new Set<string>();
  private conversationQueues = new Map<string, Promise<void>>();
  private messageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private messageRetryAttempts = new Map<string, number>();
  private shuttingDown = false;
  private startupError?: string;
  private registeredGuilds: string[] = [];

  constructor(private readonly deps: DiscordAgentDependencies = {}) {
    this.state = deps.state || new DiscordStateStore();
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    // Gateway transport means Discord needs no public webhook route or hostname.
    return new Map();
  }

  async startup(): Promise<void> {
    this.shuttingDown = false;
    try {
      const config = (this.config = (
        this.deps.loadConfig || loadDiscordConfig
      )());
      const rest = (this.rest = (
        this.deps.rest ||
        ((value) => new DiscordRest(value.token, value.applicationId))
      )(config));
      this.bot = await rest.currentBot();
      if (this.bot.id !== config.applicationId) {
        throw new Error(
          "Discord bot identity does not match DISCORD_APPLICATION_ID",
        );
      }
      const guilds = await rest.currentGuilds();
      this.guildNames = Object.fromEntries(
        guilds.map((guild) => [guild.id, guild.name]),
      );
      const missing = config.guildIds.filter((id) => !this.guildNames[id]);
      if (missing.length) {
        throw new Error(
          `Discord bot is not installed in allowed guild(s): ${missing.join(", ")}`,
        );
      }
      for (const guildId of config.guildIds) {
        for (const command of DISCORD_COMMANDS) {
          await rest.syncGuildCommand(guildId, command);
        }
        this.registeredGuilds.push(guildId);
      }
      const gatewayInfo = await rest.gatewayBot();
      const gatewayOptions: ConstructorParameters<typeof DiscordGateway>[0] = {
        token: config.token,
        intents: DISCORD_GATEWAY_INTENTS,
        gatewayUrl: gatewayInfo.url,
        checkpoint: () => this.state.gateway(),
        saveCheckpoint: (checkpoint) => {
          this.state.setGateway(checkpoint);
          this.state.save();
        },
        onDispatch: (name, data) => this.onDispatch(name, data),
        onReady: (data) => {
          if (data?.user?.id && data.user.id !== this.bot?.id) {
            throw new Error("Discord Gateway READY identity mismatch");
          }
        },
      };
      this.gateway = (
        this.deps.gateway || ((options) => new DiscordGateway(options))
      )(gatewayOptions);
      this.gateway.start();
      this.resumePendingMessages();
      console.log(
        `[discord] ${this.bot.username} connected for ${config.guildIds.map((id) => this.guildNames[id]).join(", ")}`,
      );
    } catch (error) {
      this.startupError = safeError(error);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.messageRetryTimers.values()) clearTimeout(timer);
    this.messageRetryTimers.clear();
    this.gateway?.stop();
    this.state.save();
  }

  health(): Record<string, unknown> {
    return {
      configured: !!this.config,
      bot: this.bot ? { id: this.bot.id, username: this.bot.username } : null,
      guilds: this.registeredGuilds.map((id) => ({
        id,
        name: this.guildNames[id],
      })),
      commandsRegistered: this.registeredGuilds.length,
      token: this.config ? discordTokenSourceHealth(this.config) : null,
      gateway: this.gateway?.health() || { status: "stopped", ready: false },
      inflightEvents: this.inflightEvents.size,
      pendingMessages: this.state.pendingMessageCount(),
      retryingMessages: this.messageRetryTimers.size,
      activeConversations: this.conversationQueues.size,
      ...(this.startupError ? { error: this.startupError } : {}),
    };
  }

  private async onDispatch(name: string, data: unknown): Promise<void> {
    if (name === "MESSAGE_CREATE") {
      await this.acceptMessage(data as DiscordMessage);
    } else if (name === "INTERACTION_CREATE") {
      void this.acceptInteraction(data as DiscordInteraction);
    }
  }

  private async acceptMessage(message: DiscordMessage): Promise<void> {
    if (!message?.id || !message.channel_id || !message.author?.id) return;
    if (message.author.bot || message.author.id === this.bot?.id) return;
    // Discord's default and reply message types are human conversation. Ignore
    // member joins, thread notices, boosts, and other system-generated events.
    if (message.type !== undefined && ![0, 19].includes(message.type)) return;
    if (this.state.wasProcessed(message.id)) return;
    const pending = this.state.pendingMessage(message.id);
    if (pending) {
      this.scheduleMessage(pending.message as DiscordMessage);
      return;
    }
    if (this.inflightEvents.has(message.id)) return;
    if (
      !(await this.allowed(
        message.guild_id,
        message.channel_id,
        message.author.id,
        message.member?.roles,
      ))
    )
      return;

    const originalKey = conversationKey(message.guild_id, message.channel_id);
    const linked = this.state.conversation(originalKey);
    const mentioned =
      !message.guild_id ||
      !!message.mentions?.some((user) => user.id === this.bot?.id) ||
      (!!this.bot?.id && !!message.content?.includes(`<@${this.bot.id}>`));
    const managedThread =
      !linked && !mentioned
        ? await this.isManagedThreadChannel(message.channel_id)
        : false;
    if (!linked && !mentioned && !managedThread) return;
    if (managedThread && !linked) {
      this.state.setConversation(originalKey, {
        sessionId: "",
        model: this.requireConfig().defaultModel,
        mode: "code",
        userId: message.author.id,
        updatedAt: new Date().toISOString(),
        openingEventId: message.id,
      });
    }

    // Persist accepted intake before the Gateway sequence checkpoint advances.
    // A restart can then replay the exact event without duplicating a turn.
    this.state.enqueueMessage(message.id, message);
    this.scheduleMessage(message);
  }

  private resumePendingMessages(): void {
    for (const pending of this.state.pendingMessages()) {
      this.scheduleMessage(pending.message as DiscordMessage);
    }
  }

  private scheduleMessage(message: DiscordMessage): void {
    if (
      !message?.id ||
      !message.channel_id ||
      !message.author?.id ||
      this.shuttingDown ||
      this.state.wasProcessed(message.id) ||
      this.inflightEvents.has(message.id)
    ) {
      return;
    }
    this.inflightEvents.add(message.id);
    void this.processMessage(message).then(
      () => {
        this.messageRetryAttempts.delete(message.id);
        const timer = this.messageRetryTimers.get(message.id);
        if (timer) clearTimeout(timer);
        this.messageRetryTimers.delete(message.id);
      },
      (error) => {
        console.error(
          `[discord] pending message ${message.id} could not be processed: ${safeError(error)}`,
        );
        if (!this.state.pendingMessage(message.id) || this.shuttingDown) return;
        const attempt = (this.messageRetryAttempts.get(message.id) || 0) + 1;
        this.messageRetryAttempts.set(message.id, attempt);
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        const timer = setTimeout(() => {
          this.messageRetryTimers.delete(message.id);
          this.scheduleMessage(message);
        }, delayMs);
        this.messageRetryTimers.set(message.id, timer);
      },
    );
  }

  private async processMessage(message: DiscordMessage): Promise<void> {
    const originalKey = conversationKey(message.guild_id, message.channel_id);
    const mentioned =
      !message.guild_id ||
      !!message.mentions?.some((user) => user.id === this.bot?.id) ||
      (!!this.bot?.id && !!message.content?.includes(`<@${this.bot.id}>`));
    // A mention in an ordinary guild channel is the conversational equivalent
    // of opening a new OpenSession: always create a fresh Discord thread even
    // when `/os ask` previously linked the parent channel. Mentions and plain
    // replies inside an already-linked thread continue that thread's session.
    const startFreshThread =
      !!message.guild_id &&
      mentioned &&
      !(await this.isThreadChannel(message.channel_id));

    let outputChannel = message.channel_id;
    let key = originalKey;
    try {
      let prompt = this.stripMention(message.content || "").trim();
      if (
        !prompt &&
        !message.attachments?.length &&
        !message.message_reference?.message_id
      ) {
        prompt = "Please inspect the attached context and help.";
      }
      if (startFreshThread) {
        try {
          const thread = await this.ensureThread(message, prompt);
          outputChannel = thread.id;
          key = conversationKey(message.guild_id, thread.id);
          this.channelCache.set(thread.id, thread);
          if (!this.state.conversation(key)) {
            this.state.setConversation(key, {
              sessionId: "",
              model: this.requireConfig().defaultModel,
              mode: "code",
              userId: message.author!.id,
              updatedAt: new Date().toISOString(),
              openingEventId: message.id,
            });
          }
        } catch (error) {
          console.warn(`[discord] thread creation failed: ${safeError(error)}`);
          await this.requireRest().sendMessage(
            message.channel_id,
            "OpenSession couldn't create a thread for this request. Check the bot's thread permissions and try the mention again.",
            message.id,
            messageNonce(message.id, "thread-error"),
          );
          this.state.markProcessed(message.id);
          return;
        }
      }
      const contextLink = this.state.conversation(key);
      const includeRecentContext =
        startFreshThread ||
        !contextLink ||
        (contextLink.sessionId === "" &&
          contextLink.openingEventId === message.id);
      const fullPrompt = await this.promptWithDiscordContext(
        message,
        prompt,
        includeRecentContext,
      );
      await this.enqueueConversation(key, async () => {
        const status = await this.requireRest().sendMessage(
          outputChannel,
          "OpenSession is starting…",
          outputChannel === message.channel_id ? message.id : undefined,
          messageNonce(message.id, "status"),
        );
        try {
          const result = await this.runPrompt({
            key,
            eventId: message.id,
            prompt: fullPrompt.text,
            images: fullPrompt.images,
            user: message.author!,
            onProgress: (text) =>
              this.requireRest().editMessage(outputChannel, status.id, text),
            onSessionCreated: (sessionId) =>
              this.requireRest().sendMessage(
                outputChannel,
                `Follow this session in OpenSession: ${sessionLink(sessionId)}`,
                undefined,
                messageNonce(message.id, "session-link"),
              ),
          });
          await this.finishMessage(
            outputChannel,
            status.id,
            result,
            message.id,
          );
          this.state.markProcessed(message.id);
        } catch (error) {
          if (retryableError(error)) throw error;
          try {
            await this.requireRest().editMessage(
              outputChannel,
              status.id,
              `OpenSession failed: ${safeError(error)}`,
            );
          } finally {
            this.state.markProcessed(message.id);
          }
        }
      });
    } finally {
      this.inflightEvents.delete(message.id);
    }
  }

  private async ensureThread(
    message: DiscordMessage,
    prompt: string,
  ): Promise<DiscordChannel> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.requireRest().startThread(
          message.channel_id,
          message.id,
          `OpenSession — ${prompt.replace(/\s+/g, " ").slice(0, 70) || "request"}`,
        );
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(500);
      }
    }
    try {
      const existing = await this.requireRest().channel(message.id);
      if (
        [10, 11, 12].includes(existing.type) &&
        existing.parent_id === message.channel_id
      ) {
        return existing;
      }
    } catch {}
    throw lastError || new Error("Discord thread creation failed");
  }

  private async acceptInteraction(
    interaction: DiscordInteraction,
  ): Promise<void> {
    if (
      interaction?.type !== 2 ||
      interaction.data?.name !== "os" ||
      !interaction.id ||
      !interaction.token ||
      !interaction.channel_id
    )
      return;
    const user = interaction.member?.user || interaction.user;
    if (!user?.id) return;
    const allowed = await this.allowed(
      interaction.guild_id,
      interaction.channel_id,
      user.id,
      interaction.member?.roles,
    );
    if (!allowed) {
      await this.requireRest().interactionCallback(
        interaction.id,
        interaction.token,
        {
          type: 4,
          data: {
            content: "This OpenSession bot is not enabled for you here.",
            flags: 64,
          },
        },
      );
      return;
    }
    if (
      this.state.wasProcessed(interaction.id) ||
      this.inflightEvents.has(interaction.id)
    )
      return;

    const key = conversationKey(interaction.guild_id, interaction.channel_id);
    const { subcommand, values } = commandParts(interaction);
    if (subcommand !== "ask") {
      const content = await this.runCommand(
        key,
        subcommand,
        values,
        user,
        interaction.id,
      );
      await this.requireRest().interactionCallback(
        interaction.id,
        interaction.token,
        {
          type: 4,
          data: {
            content: content.slice(0, 2_000),
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        },
      );
      this.state.markProcessed(interaction.id);
      return;
    }

    this.inflightEvents.add(interaction.id);
    await this.requireRest().interactionCallback(
      interaction.id,
      interaction.token,
      {
        type: 5,
        data: { allowed_mentions: { parse: [] } },
      },
    );
    try {
      await this.enqueueConversation(key, async () => {
        try {
          const result = await this.runPrompt({
            key,
            eventId: interaction.id,
            prompt: values.prompt || "",
            images: [],
            user,
            timeoutMs: Math.min(
              this.requireConfig().responseTimeoutMs,
              13 * 60_000,
            ),
            onProgress: (text) =>
              this.requireRest().editOriginalInteraction(
                interaction.token,
                text,
              ),
            onSessionCreated: (sessionId) =>
              this.requireRest().editOriginalInteraction(
                interaction.token,
                `OpenSession is working. Follow it here: ${sessionLink(sessionId)}`,
              ),
          });
          await this.finishInteraction(interaction.token, result);
          this.state.markProcessed(interaction.id);
        } catch (error) {
          try {
            await this.requireRest().editOriginalInteraction(
              interaction.token,
              `OpenSession failed: ${safeError(error)}`,
            );
          } finally {
            this.state.markProcessed(interaction.id);
          }
        }
      });
    } finally {
      this.inflightEvents.delete(interaction.id);
    }
  }

  private async runCommand(
    key: string,
    command: string,
    values: Record<string, string>,
    user: DiscordUser,
    eventId: string,
  ): Promise<string> {
    const control = this.requireControl();
    const conversation = this.state.conversation(key);
    if (command === "new") {
      this.state.deleteConversation(key);
      return "The channel is unlinked. Your next `/os ask` or mention starts a fresh Docker-backed OpenSession.";
    }
    if (command === "status") {
      if (!conversation?.sessionId)
        return "No OpenSession is linked to this channel yet.";
      const summary = control.getSession(conversation.sessionId);
      return summary
        ? `**${summary.title}** — ${summary.state}\nModel: \`${summary.model || conversation.model || "default"}\`\n${sessionLink(summary.id)}`
        : "The linked OpenSession no longer exists. Use `/os new`, then `/os ask`.";
    }
    if (command === "stop") {
      if (!conversation?.sessionId)
        return "No OpenSession is linked to this channel yet.";
      const stopped = await control.cancelSession(conversation.sessionId, {
        requestId: `discord:${eventId}:stop`,
      });
      return stopped ? "Stop requested." : "There is no active run to stop.";
    }
    if (command === "model") {
      const model = values.model;
      if (!model || !resolveModel(model))
        return `Unknown OpenSession model: \`${model || ""}\``;
      if (conversation?.sessionId) {
        const result = await control.deliverToSession(
          conversation.sessionId,
          `/model ${model}`,
          displayName(user),
          { deliveryId: `discord:${eventId}:model`, busy: "queue" },
        );
        if (result.status === "error") return result.message;
      }
      this.state.setConversation(key, {
        sessionId: conversation?.sessionId || "",
        mode: "code",
        model,
        userId: user.id,
        updatedAt: new Date().toISOString(),
      });
      return `This channel now uses \`${model}\`.`;
    }
    return "Unknown OpenSession command.";
  }

  private async runPrompt(input: {
    key: string;
    eventId: string;
    prompt: string;
    images: string[];
    user: DiscordUser;
    timeoutMs?: number;
    onProgress: (text: string) => Promise<unknown>;
    onSessionCreated?: (sessionId: string) => Promise<unknown>;
  }): Promise<string> {
    const control = this.requireControl();
    let conversation = this.state.conversation(input.key);
    let existing = conversation?.sessionId
      ? control.getSession(conversation.sessionId)
      : undefined;
    if (conversation?.sessionId && !existing) {
      this.state.deleteConversation(input.key);
      conversation = undefined;
    } else if (existing?.mode === "ask") {
      // Discord is always an auto-permission surface. A link created before
      // that invariant cannot be upgraded in place because Ask sessions own a
      // read-only checkout, so retire the link and start a Code session below.
      this.state.deleteConversation(input.key);
      conversation = undefined;
      existing = undefined;
    }

    const resumesOpening =
      !!existing && conversation?.openingEventId === input.eventId;
    const baselineEntries =
      existing && !resumesOpening
        ? await control.transcriptTail(existing.id, 200)
        : [];
    let baseline = new Set(baselineEntries.map((entry) => entry.id));
    let baselineRunError =
      !resumesOpening && existing?.lastRunError
        ? `${existing.lastRunError.at}\0${existing.lastRunError.message}`
        : undefined;
    let sessionId: string;
    let route:
      | "created"
      | "continued"
      | "resumed-opening"
      | "resumed-delivery" = existing ? "continued" : "created";
    if (existing && resumesOpening) {
      sessionId = existing.id;
      route = "resumed-opening";
    } else if (
      existing?.state === "waiting_question" &&
      existing.pendingQuestion
    ) {
      const answers = answerMap(existing.pendingQuestion, input.prompt);
      if (!Object.keys(answers).length)
        return describeQuestion(existing.pendingQuestion);
      const answered = await control.answerQuestion(existing.id, answers, {
        requestId: `discord:${input.eventId}:answer`,
      });
      if (!answered)
        throw new Error("OpenSession no longer has a pending question");
      sessionId = existing.id;
    } else if (existing) {
      const delivered = await control.deliverToSession(
        existing.id,
        input.prompt,
        displayName(input.user),
        {
          busy: "queue",
          hold: true,
          deliveryId: `discord:${input.eventId}:prompt`,
          ...(input.images.length
            ? {
                imageUrls: input.images,
                images: input.images.map((url) => {
                  const match = /^data:([^;]+);base64,(.*)$/s.exec(url)!;
                  return { mediaType: match[1], data: match[2] };
                }),
              }
            : {}),
        },
      );
      if (delivered.status === "error") throw new Error(delivered.message);
      if (delivered.duplicate) {
        baseline = new Set();
        baselineRunError = undefined;
        route = "resumed-delivery";
      }
      sessionId = existing.id;
    } else {
      // Discord is an internal, team-role-gated surface. Its sessions always
      // use Code mode so ordinary tool calls are approved without pausing a
      // thread. Hard-denied and confirm-gated tools keep their global policy.
      const model = conversation?.model || this.requireConfig().defaultModel;
      const created = await control.createSession({
        prompt: input.prompt,
        requestId: `discord:${input.eventId}:create`,
        requestScope: `discord:${input.user.id}:${input.key}`,
        mode: "code",
        ...(model ? { model } : {}),
        images: input.images,
        sandbox: "docker",
        user: displayName(input.user),
      });
      sessionId = created.id;
      route = "created";
      this.state.setConversation(input.key, {
        sessionId,
        model,
        mode: "code",
        userId: input.user.id,
        updatedAt: new Date().toISOString(),
        openingEventId: input.eventId,
      });
      // Post the link as soon as the session exists so the requester can
      // follow a long run before the first answer lands.
      await input.onSessionCreated?.(sessionId).catch((error) => {
        console.warn(`[discord] session link post failed: ${safeError(error)}`);
      });
    }

    console.log(
      `[discord] event=${input.eventId} session=${sessionId} route=${route} conversation=${input.key}`,
    );

    return await this.waitForAnswer(
      sessionId,
      baseline,
      input.timeoutMs || this.requireConfig().responseTimeoutMs,
      input.onProgress,
      baselineRunError,
    );
  }

  private async waitForAnswer(
    sessionId: string,
    baseline: Set<string>,
    timeoutMs: number,
    onProgress: (text: string) => Promise<unknown>,
    baselineRunError?: string,
  ): Promise<string> {
    const control = this.requireControl();
    const started = Date.now();
    let lastProgress = 0;
    let sawActive = false;
    while (Date.now() - started < timeoutMs) {
      const summary = control.getSession(sessionId);
      const entries = await control.transcriptTail(sessionId, 200);
      const answer = latestAssistant(entries, baseline);
      if (summary?.state === "waiting_question" && summary.pendingQuestion) {
        return describeQuestion(summary.pendingQuestion);
      }
      const currentRunError = summary?.lastRunError
        ? `${summary.lastRunError.at}\0${summary.lastRunError.message}`
        : undefined;
      if (
        currentRunError &&
        currentRunError !== baselineRunError &&
        summary &&
        !["running", "queued", "waiting_question"].includes(summary.state)
      ) {
        throw new Error(summary.lastRunError!.message);
      }
      if (
        summary &&
        ["running", "queued", "waiting_question"].includes(summary.state)
      ) {
        sawActive = true;
      }
      if (answer && summary && !["running", "queued"].includes(summary.state)) {
        return `${answer}\n\n[Open in OpenSession](${sessionLink(sessionId)})`;
      }
      if (
        Date.now() - lastProgress >= 12_000 &&
        summary &&
        (sawActive || Date.now() - started > 4_000)
      ) {
        const latestTool = [...entries]
          .reverse()
          .find((entry) => entry.type === "tool_use")?.toolName;
        const elapsed = Math.max(1, Math.floor((Date.now() - started) / 1_000));
        await onProgress(
          `OpenSession is ${summary.state.replace("_", " ")} (${elapsed}s)${latestTool ? ` — ${latestTool}` : ""}…\nFollow it here: ${sessionLink(sessionId)}`,
        ).catch(() => {});
        lastProgress = Date.now();
      }
      await sleep(1_000);
    }
    return `OpenSession is still working. Follow it here: ${sessionLink(sessionId)}`;
  }

  private async finishMessage(
    channelId: string,
    statusId: string,
    text: string,
    eventId: string,
  ): Promise<void> {
    const chunks = splitDiscordMessage(text);
    await this.requireRest().editMessage(channelId, statusId, chunks[0]);
    for (const [index, chunk] of chunks.slice(1).entries()) {
      await this.requireRest().sendMessage(
        channelId,
        chunk,
        undefined,
        messageNonce(eventId, `answer-${index + 1}`),
      );
    }
  }

  private async finishInteraction(token: string, text: string): Promise<void> {
    const chunks = splitDiscordMessage(text);
    await this.requireRest().editOriginalInteraction(token, chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await this.requireRest().followupInteraction(token, chunk);
    }
  }

  private enqueueConversation(
    key: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.conversationQueues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.conversationQueues.get(key) === next)
          this.conversationQueues.delete(key);
      });
    this.conversationQueues.set(key, next);
    return next;
  }

  private async allowed(
    guildId: string | undefined,
    channelId: string,
    userId: string,
    memberRoleIds: string[] = [],
  ): Promise<boolean> {
    const config = this.requireConfig();
    if (config.userIds.length && !config.userIds.includes(userId)) return false;
    if (!guildId) return config.userIds.includes(userId);
    if (!config.guildIds.includes(guildId)) return false;
    if (
      config.roleIds.length &&
      !memberRoleIds.some((roleId) => config.roleIds.includes(roleId))
    )
      return false;
    if (!config.channelIds.length || config.channelIds.includes(channelId))
      return true;
    try {
      const channel = await this.cachedChannel(channelId);
      return (
        !!channel.parent_id && config.channelIds.includes(channel.parent_id)
      );
    } catch {
      return false;
    }
  }

  private async cachedChannel(id: string): Promise<DiscordChannel> {
    const cached = this.channelCache.get(id);
    if (cached) return cached;
    const channel = await this.requireRest().channel(id);
    this.channelCache.set(id, channel);
    return channel;
  }

  private async isThreadChannel(id: string): Promise<boolean> {
    try {
      // Announcement, public, and private threads respectively.
      return [10, 11, 12].includes((await this.cachedChannel(id)).type);
    } catch {
      // A failed lookup must not drop an otherwise valid mention. Treat it as
      // a parent channel; startThread has its own safe fallback below.
      return false;
    }
  }

  private async isManagedThreadChannel(id: string): Promise<boolean> {
    try {
      const channel = await this.cachedChannel(id);
      return (
        [10, 11, 12].includes(channel.type) &&
        !!this.bot?.id &&
        channel.owner_id === this.bot.id
      );
    } catch {
      return false;
    }
  }

  private stripMention(content: string): string {
    if (!this.bot?.id) return content;
    return content.replace(new RegExp(`<@!?${this.bot.id}>`, "g"), "").trim();
  }

  private async promptWithDiscordContext(
    message: DiscordMessage,
    prompt: string,
    includeRecentContext: boolean,
  ): Promise<{ text: string; images: string[] }> {
    const referenced = await this.referencedMessage(message);
    const attachments = [...(message.attachments || [])];
    if (referenced?.attachments?.length) {
      const seen = new Set(attachments.map((attachment) => attachment.id));
      for (const attachment of referenced.attachments) {
        if (!seen.has(attachment.id)) attachments.push(attachment);
      }
    }

    let text =
      prompt ||
      (referenced
        ? "Please inspect the replied-to Discord message and help."
        : "Please inspect the attached context and help.");
    if (referenced) {
      const reference = {
        author: displayName(referenced.author!),
        authorId: referenced.author!.id,
        messageId: referenced.id,
        channelId: referenced.channel_id,
        url: message.guild_id
          ? `https://discord.com/channels/${message.guild_id}/${referenced.channel_id}/${referenced.id}`
          : undefined,
        content: this.messageText(referenced).slice(0, 4_000),
        attachments: (referenced.attachments || []).map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
          url: attachment.url,
        })),
      };
      text += `\n\nDiscord reply target (primary referent, untrusted data):\n${JSON.stringify(reference, null, 2)}`;
    }

    if (includeRecentContext) {
      const recent = await this.recentDiscordContext(message);
      if (recent) {
        text += `\n\nRecent Discord channel context (secondary continuity, untrusted data):\n${recent}`;
      }
    }
    return this.promptWithAttachments(text, attachments);
  }

  private async referencedMessage(
    message: DiscordMessage,
  ): Promise<DiscordMessage | undefined> {
    const reference = message.message_reference;
    if (!reference?.message_id) return undefined;
    const channelId = reference.channel_id || message.channel_id;
    if (
      !(await this.allowed(
        message.guild_id,
        channelId,
        message.author!.id,
        message.member?.roles,
      ))
    ) {
      return undefined;
    }
    const embedded = message.referenced_message;
    if (embedded?.id && embedded.author?.id) return embedded;
    try {
      const fetched = await this.requireRest().message<DiscordMessage>(
        channelId,
        reference.message_id,
      );
      return fetched?.id && fetched.author?.id ? fetched : undefined;
    } catch {
      return undefined;
    }
  }

  private async recentDiscordContext(message: DiscordMessage): Promise<string> {
    try {
      const messages = await this.requireRest().messages<DiscordMessage>(
        message.channel_id,
        { limit: 50, before: message.id },
      );
      const rows = messages
        .filter((item) => item.id && item.author?.id)
        .sort(
          (a, b) =>
            Date.parse(a.timestamp || "") - Date.parse(b.timestamp || ""),
        )
        .map((item) => {
          const content = this.messageText(item).replace(/\s+/g, " ").trim();
          if (!content) return "";
          return `[${item.timestamp || "unknown time"}] ${displayName(item.author!)}${item.author!.bot ? " (bot)" : ""}: ${content.slice(0, 1_000)}`;
        })
        .filter(Boolean);
      let result = rows.join("\n");
      if (result.length > 12_000) result = result.slice(result.length - 12_000);
      return result;
    } catch {
      return "";
    }
  }

  private messageText(message: DiscordMessage): string {
    const rows = [message.content || ""];
    for (const embed of message.embeds || []) {
      const fields = (embed.fields || [])
        .map((field) => `${field.name || "Field"}: ${field.value || ""}`)
        .join("\n");
      rows.push(
        [embed.title, embed.description, fields, embed.url]
          .filter((value): value is string => !!value)
          .join("\n"),
      );
    }
    return rows.filter(Boolean).join("\n").trim();
  }

  private async promptWithAttachments(
    prompt: string,
    attachments: DiscordAttachment[],
  ): Promise<{ text: string; images: string[] }> {
    const images: string[] = [];
    const rows: string[] = [];
    for (const attachment of attachments.slice(0, 10)) {
      const mime = attachment.content_type || "";
      let parsed: URL;
      try {
        parsed = new URL(attachment.url);
      } catch {
        continue;
      }
      const trustedHost = [
        "cdn.discordapp.com",
        "media.discordapp.net",
      ].includes(parsed.hostname);
      if (
        trustedHost &&
        mime.startsWith("image/") &&
        !!attachment.size &&
        attachment.size <= 4 * 1024 * 1024
      ) {
        try {
          const response = await fetch(parsed, {
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (response.ok) {
            const declaredLength = Number(
              response.headers.get("content-length") || attachment.size,
            );
            if (declaredLength > 4 * 1024 * 1024) {
              rows.push(`- ${attachment.filename}: ${attachment.url}`);
              continue;
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > 4 * 1024 * 1024) {
              rows.push(`- ${attachment.filename}: ${attachment.url}`);
              continue;
            }
            images.push(
              `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            );
            rows.push(`- ${attachment.filename} (image attached)`);
            continue;
          }
        } catch {}
      }
      rows.push(`- ${attachment.filename}: ${attachment.url}`);
    }
    return {
      text: rows.length
        ? `${prompt}\n\nDiscord attachments:\n${rows.join("\n")}`
        : prompt,
      images,
    };
  }

  private requireConfig(): DiscordConfig {
    if (!this.config) throw new Error("Discord agent has not started");
    return this.config;
  }

  private requireRest(): DiscordRest {
    if (!this.rest) throw new Error("Discord REST client has not started");
    return this.rest;
  }

  private requireControl(): SessionControl {
    return (this.deps.control || getSessionControl)();
  }
}
