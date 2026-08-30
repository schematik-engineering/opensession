import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SessionControl } from "../../server/session-control";
import { DiscordRest, splitDiscordMessage } from "./api";
import { loadDiscordConfig, type DiscordConfig } from "./config";
import { DiscordGateway } from "./gateway";
import { DISCORD_COMMANDS, DiscordAgent } from "./index";
import { DiscordStateStore } from "./state";

const tempDirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opensession-discord-"));
  tempDirs.push(dir);
  return dir;
}

function config(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    applicationId: "1542925450790305903",
    tokenFile: "/tmp/not-used",
    token: "test-token",
    guildIds: ["1542925450790305904"],
    channelIds: [],
    roleIds: [],
    userIds: ["1542925450790305909"],
    defaultModel: "grok/grok-4.6",
    sandbox: "docker",
    responseTimeoutMs: 30_000,
    ...overrides,
  };
}

describe("Discord config and state", () => {
  test("requires an explicit guild allowlist and a private token file", () => {
    const dir = tempDir();
    const tokenFile = join(dir, "bot-token");
    writeFileSync(tokenFile, "secret-value\n", { mode: 0o600 });
    process.env.DISCORD_APPLICATION_ID = "1542925450790305903";
    process.env.DISCORD_BOT_TOKEN_FILE = tokenFile;
    process.env.DISCORD_GUILD_IDS = "1542925450790305904";
    process.env.DISCORD_ROLE_IDS = "1542925450790305906";
    delete process.env.DISCORD_BOT_TOKEN;
    const loaded = loadDiscordConfig();
    expect(loaded.token).toBe("secret-value");
    expect(loaded.guildIds).toEqual(["1542925450790305904"]);
    expect(loaded.roleIds).toEqual(["1542925450790305906"]);

    delete process.env.DISCORD_GUILD_IDS;
    expect(() => loadDiscordConfig()).toThrow("fails closed");

    process.env.DISCORD_GUILD_IDS = "1542925450790305904";
    process.env.DISCORD_USER_IDS = "1542925450790305905";
    chmodSync(tokenFile, 0o644);
    expect(() => loadDiscordConfig()).toThrow("private regular file");
  });

  test("persists channel linkage, gateway resume state, and dedup", () => {
    const path = join(tempDir(), "state.json");
    const store = new DiscordStateStore(path);
    store.setGateway({
      sessionId: "gateway",
      resumeGatewayUrl: "wss://resume",
      seq: 7,
    });
    store.setConversation("guild:g:channel:c", {
      sessionId: "os-session",
      mode: "code",
      model: "cursor/auto",
      userId: "1542925450790305905",
      updatedAt: new Date().toISOString(),
    });
    store.markProcessed("event-1");

    const restored = new DiscordStateStore(path);
    expect(restored.gateway()).toEqual({
      sessionId: "gateway",
      resumeGatewayUrl: "wss://resume",
      seq: 7,
    });
    expect(restored.conversation("guild:g:channel:c")?.sessionId).toBe(
      "os-session",
    );
    expect(restored.wasProcessed("event-1")).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("secret-value");
  });

  test("drops legacy Ask-mode links instead of resuming permission prompts", () => {
    const path = join(tempDir(), "state.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        gateway: {},
        conversations: {
          "guild:g:channel:c": {
            sessionId: "legacy-ask-session",
            mode: "ask",
            userId: "1542925450790305905",
            updatedAt: new Date().toISOString(),
          },
        },
        processed: {},
      }),
      { mode: 0o600 },
    );

    expect(
      new DiscordStateStore(path).conversation("guild:g:channel:c"),
    ).toBeUndefined();
  });
});

describe("Discord REST presentation", () => {
  test("offers no permission-mode override on Discord prompts", () => {
    const command = DISCORD_COMMANDS[0] as {
      options?: Array<{
        name?: string;
        options?: Array<{ name?: string }>;
      }>;
    };
    const ask = command.options?.find((option) => option.name === "ask");
    expect(ask?.options?.map((option) => option.name)).toEqual(["prompt"]);
  });

  test("splits long replies without losing content", () => {
    const input = `${"a".repeat(1_500)}\n${"b".repeat(1_500)}`;
    const chunks = splitDiscordMessage(input);
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= 1_900)).toBe(true);
    expect(chunks.join("\n")).toBe(input);
  });

  test("suppresses mentions on outbound messages", async () => {
    let body: any;
    const fakeFetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ id: "m1", channel_id: "c1" });
    }) as typeof fetch;
    const rest = new DiscordRest("token", "1542925450790305903", fakeFetch);
    await rest.sendMessage("c1", "@everyone <@123>");
    expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false });
  });
});

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(name: string, callback: (event: any) => void) {
    const rows = this.listeners.get(name) || [];
    rows.push(callback);
    this.listeners.set(name, rows);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close(code = 1000, reason = "") {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  emit(name: string, event: any) {
    for (const callback of this.listeners.get(name) || []) callback(event);
  }

  message(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

describe("Discord Gateway", () => {
  test("identifies, checkpoints READY, and reports healthy", async () => {
    const socket = new FakeSocket();
    let checkpoint: any = {};
    const gateway = new DiscordGateway({
      token: "secret",
      intents: 37_377,
      gatewayUrl: "wss://gateway.discord.gg",
      checkpoint: () => checkpoint,
      saveCheckpoint: (value) => {
        checkpoint = value;
      },
      onDispatch: () => {},
      webSocketFactory: () => socket as unknown as WebSocket,
      random: () => 0.5,
    });
    gateway.start();
    socket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await Bun.sleep(1);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      op: 2,
      d: { token: "secret", intents: 37_377 },
    });
    socket.message({
      op: 0,
      s: 9,
      t: "READY",
      d: { session_id: "gw-session", resume_gateway_url: "wss://resume" },
    });
    await Bun.sleep(1);
    expect(checkpoint).toEqual({
      seq: 9,
      sessionId: "gw-session",
      resumeGatewayUrl: "wss://resume",
    });
    expect(gateway.health().ready).toBe(true);
    gateway.stop();
  });

  test("resumes from a durable session and sequence", async () => {
    const socket = new FakeSocket();
    let checkpoint = {
      sessionId: "gw-session",
      resumeGatewayUrl: "wss://resume",
      seq: 11,
    };
    const gateway = new DiscordGateway({
      token: "secret",
      intents: 37_377,
      gatewayUrl: "wss://gateway.discord.gg",
      checkpoint: () => checkpoint,
      saveCheckpoint: (value) => {
        checkpoint = value as typeof checkpoint;
      },
      onDispatch: () => {},
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    gateway.start();
    socket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await Bun.sleep(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      op: 6,
      d: { token: "secret", session_id: "gw-session", seq: 11 },
    });
    gateway.stop();
  });

  test("reconnects with resume and treats authentication close codes as fatal", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let socketIndex = 0;
    let checkpoint: any = {};
    const gateway = new DiscordGateway({
      token: "secret",
      intents: 37_377,
      gatewayUrl: "wss://gateway.discord.gg",
      checkpoint: () => checkpoint,
      saveCheckpoint: (value) => {
        checkpoint = value;
      },
      onDispatch: () => {},
      webSocketFactory: () => sockets[socketIndex++] as unknown as WebSocket,
      random: () => 0,
    });
    gateway.start();
    sockets[0].message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await Bun.sleep(1);
    sockets[0].message({
      op: 0,
      s: 12,
      t: "READY",
      d: { session_id: "gw-session", resume_gateway_url: "wss://resume" },
    });
    await Bun.sleep(1);
    sockets[0].close(4000, "reconnect");
    await Bun.sleep(1_100);
    expect(socketIndex).toBe(2);
    sockets[1].message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await Bun.sleep(1);
    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      op: 6,
      d: { token: "secret", session_id: "gw-session", seq: 12 },
    });
    sockets[1].message({ op: 0, s: 13, t: "RESUMED", d: {} });
    await Bun.sleep(1);
    expect(gateway.health()).toMatchObject({ ready: true, resumed: true });
    gateway.stop();

    const fatalSocket = new FakeSocket();
    const fatal = new DiscordGateway({
      token: "secret",
      intents: 37_377,
      gatewayUrl: "wss://gateway.discord.gg",
      checkpoint: () => ({}),
      saveCheckpoint: () => {},
      onDispatch: () => {},
      webSocketFactory: () => fatalSocket as unknown as WebSocket,
    });
    fatal.start();
    fatalSocket.close(4004, "authentication failed");
    expect(fatal.health()).toMatchObject({
      status: "fatal",
      ready: false,
    });
    fatal.stop();
  });
});

describe("Discord agent", () => {
  test("starts a fresh code-mode thread on mention, attributes teammate replies, and deduplicates", async () => {
    const state = new DiscordStateStore(join(tempDir(), "state.json"));
    const edits: string[] = [];
    const creates: any[] = [];
    const deliveries: Array<{ prompt: string; user?: string }> = [];
    const parentChannel = "1542925450790305908";
    const cfg = config({
      channelIds: [parentChannel],
      roleIds: ["1542925450790305905"],
      userIds: ["1542925450790305909", "1542925450790305916"],
    });
    const threadChannel = "1542925450790305906";
    state.setConversation(`guild:${cfg.guildIds[0]}:channel:${parentChannel}`, {
      sessionId: "old-slash-session",
      mode: "code",
      model: "cursor/auto",
      userId: cfg.userIds[0],
      updatedAt: new Date().toISOString(),
    });
    let completedTurns = 0;
    let dispatch: (name: string, data: any) => void = () => {};
    const control: SessionControl = {
      listSessions: () => [],
      getSession: (id) =>
        ({
          id,
          state: "idle",
          title: "Discord request",
          model: "grok/grok-4.6",
        }) as any,
      transcriptTail: async () =>
        Array.from({ length: completedTurns }, (_, index) => ({
          id: `answer-${index + 1}`,
          type: "assistant" as const,
          content: index === 0 ? "GROK_DISCORD_OK" : "TEAMMATE_REPLY_OK",
          timestamp: new Date().toISOString(),
        })),
      answerQuestion: () => false,
      deliverToSession: async (_id, prompt, user) => {
        deliveries.push({ prompt, user });
        completedTurns += 1;
        return { status: "started", message: "started" };
      },
      cancelSession: () => true,
      createSession: async (input) => {
        creates.push(input);
        completedTurns += 1;
        return {
          id: "os-discord-1",
          createdBy: String(input.user),
          createdAt: new Date().toISOString(),
        };
      },
    };
    const rest = {
      currentBot: async () => ({
        id: cfg.applicationId,
        username: "OpenSession",
      }),
      currentGuilds: async () => [{ id: cfg.guildIds[0], name: "Schematik" }],
      syncGuildCommand: async () => ({}),
      gatewayBot: async () => ({ url: "wss://gateway.discord.gg", shards: 1 }),
      channel: async (id: string) => ({
        id,
        type: id === threadChannel ? 11 : 0,
      }),
      startThread: async () => ({
        id: threadChannel,
        type: 11,
        parent_id: parentChannel,
      }),
      sendMessage: async (channelId: string, content: string) => ({
        id: "status",
        channel_id: channelId,
        content,
      }),
      editMessage: async (
        _channelId: string,
        _messageId: string,
        content: string,
      ) => {
        edits.push(content);
        return { id: "status", channel_id: threadChannel, content };
      },
    };
    const agent = new DiscordAgent({
      loadConfig: () => cfg,
      state,
      control: () => control,
      rest: () => rest as unknown as DiscordRest,
      gateway: (options) => {
        dispatch = (name, data) => void options.onDispatch(name, data);
        return {
          start() {},
          stop() {},
          health: () => ({ status: "ready", ready: true }),
        } as unknown as DiscordGateway;
      },
    });
    await agent.startup();
    const event = {
      id: "1542925450790305907",
      channel_id: parentChannel,
      guild_id: cfg.guildIds[0],
      content: `<@${cfg.applicationId}> use Grok`,
      author: { id: "1542925450790305909", username: "jack" },
      member: { roles: cfg.roleIds },
      mentions: [{ id: cfg.applicationId, username: "OpenSession", bot: true }],
      attachments: [],
    };
    dispatch("MESSAGE_CREATE", event);
    for (let i = 0; i < 100 && !state.wasProcessed(event.id); i++)
      await Bun.sleep(10);
    expect(state.wasProcessed(event.id)).toBe(true);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      prompt: "use Grok",
      model: "grok/grok-4.6",
      mode: "code",
      sandbox: "docker",
      requestId: `discord:${event.id}:create`,
    });
    expect(edits.at(-1)).toContain("GROK_DISCORD_OK");
    expect(
      state.conversation(`guild:${cfg.guildIds[0]}:channel:${parentChannel}`)
        ?.sessionId,
    ).toBe("old-slash-session");
    expect(
      state.conversation(`guild:${cfg.guildIds[0]}:channel:${threadChannel}`)
        ?.sessionId,
    ).toBe("os-discord-1");

    const teammateReply = {
      id: "1542925450790305917",
      channel_id: threadChannel,
      guild_id: cfg.guildIds[0],
      content: "please continue",
      author: {
        id: "1542925450790305916",
        username: "alex",
        global_name: "Alex",
      },
      member: { roles: cfg.roleIds },
      mentions: [],
      attachments: [],
    };
    dispatch("MESSAGE_CREATE", teammateReply);
    for (let i = 0; i < 100 && !state.wasProcessed(teammateReply.id); i++)
      await Bun.sleep(10);
    expect(state.wasProcessed(teammateReply.id)).toBe(true);
    expect(creates).toHaveLength(1);
    expect(deliveries).toEqual([{ prompt: "please continue", user: "Alex" }]);
    expect(edits.at(-1)).toContain("TEAMMATE_REPLY_OK");

    dispatch("MESSAGE_CREATE", event);
    await Bun.sleep(20);
    expect(creates).toHaveLength(1);
    await agent.shutdown();
  });

  test("replaces a linked Ask session with an auto-permission Code session", async () => {
    const state = new DiscordStateStore(join(tempDir(), "state.json"));
    const cfg = config();
    const channelId = "1542925450790305930";
    const key = `guild:${cfg.guildIds[0]}:channel:${channelId}`;
    state.setConversation(key, {
      sessionId: "legacy-ask-session",
      mode: "code",
      userId: cfg.userIds[0],
      updatedAt: new Date().toISOString(),
    });
    const creates: any[] = [];
    const deliveries: string[] = [];
    let dispatch: (name: string, data: any) => void = () => {};
    const control: SessionControl = {
      listSessions: () => [],
      getSession: (id) =>
        ({
          id,
          state: "idle",
          title: "Discord request",
          mode: id === "legacy-ask-session" ? "ask" : "code",
        }) as any,
      transcriptTail: async (id) =>
        id === "replacement-code-session"
          ? [
              {
                id: "replacement-answer",
                type: "assistant",
                content: "AUTO_PERMISSION_OK",
                timestamp: new Date().toISOString(),
              },
            ]
          : [],
      answerQuestion: () => false,
      deliverToSession: async (_id, prompt) => {
        deliveries.push(prompt);
        return { status: "started", message: "started" };
      },
      cancelSession: () => false,
      createSession: async (input) => {
        creates.push(input);
        return {
          id: "replacement-code-session",
          createdBy: String(input.user),
          createdAt: new Date().toISOString(),
        };
      },
    };
    const edits: string[] = [];
    const rest = {
      currentBot: async () => ({
        id: cfg.applicationId,
        username: "OpenSession",
      }),
      currentGuilds: async () => [{ id: cfg.guildIds[0], name: "Schematik" }],
      syncGuildCommand: async () => ({}),
      gatewayBot: async () => ({ url: "wss://gateway.discord.gg", shards: 1 }),
      sendMessage: async () => ({
        id: "status",
        channel_id: channelId,
        content: "OpenSession is starting…",
      }),
      editMessage: async (
        _channelId: string,
        _messageId: string,
        content: string,
      ) => {
        edits.push(content);
        return { id: "status", channel_id: channelId, content };
      },
    };
    const agent = new DiscordAgent({
      loadConfig: () => cfg,
      state,
      control: () => control,
      rest: () => rest as unknown as DiscordRest,
      gateway: (options) => {
        dispatch = (name, data) => void options.onDispatch(name, data);
        return {
          start() {},
          stop() {},
          health: () => ({ status: "ready", ready: true }),
        } as unknown as DiscordGateway;
      },
    });
    await agent.startup();

    const event = {
      id: "1542925450790305931",
      channel_id: channelId,
      guild_id: cfg.guildIds[0],
      content: "continue without permission prompts",
      author: { id: cfg.userIds[0], username: "jack" },
      mentions: [],
      attachments: [],
    };
    dispatch("MESSAGE_CREATE", event);
    for (let i = 0; i < 100 && !state.wasProcessed(event.id); i++)
      await Bun.sleep(5);

    expect(state.wasProcessed(event.id)).toBe(true);
    expect(deliveries).toEqual([]);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ mode: "code", sandbox: "docker" });
    expect(state.conversation(key)?.sessionId).toBe("replacement-code-session");
    expect(edits.at(-1)).toContain("AUTO_PERMISSION_OK");
    await agent.shutdown();
  });

  test("rejects wrong roles, guilds, and channels before session control", async () => {
    const state = new DiscordStateStore(join(tempDir(), "state.json"));
    const callbacks: any[] = [];
    let creates = 0;
    let dispatch: (name: string, data: any) => void = () => {};
    const cfg = config({
      channelIds: ["1542925450790305910"],
      roleIds: ["1542925450790305906"],
      userIds: [],
    });
    const control: SessionControl = {
      listSessions: () => [],
      getSession: () => undefined,
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async () => ({ status: "started", message: "started" }),
      cancelSession: () => false,
      createSession: async () => {
        creates += 1;
        return {
          id: "must-not-create",
          createdBy: "test",
          createdAt: new Date().toISOString(),
        };
      },
    };
    const rest = {
      currentBot: async () => ({
        id: cfg.applicationId,
        username: "OpenSession",
      }),
      currentGuilds: async () => [{ id: cfg.guildIds[0], name: "Schematik" }],
      syncGuildCommand: async () => ({}),
      gatewayBot: async () => ({ url: "wss://gateway.discord.gg", shards: 1 }),
      channel: async (id: string) => ({ id, type: 0, parent_id: null }),
      interactionCallback: async (...args: any[]) => {
        callbacks.push(args);
      },
    };
    const agent = new DiscordAgent({
      loadConfig: () => cfg,
      state,
      control: () => control,
      rest: () => rest as unknown as DiscordRest,
      gateway: (options) => {
        dispatch = (name, data) => void options.onDispatch(name, data);
        return {
          start() {},
          stop() {},
          health: () => ({ status: "ready", ready: true }),
        } as unknown as DiscordGateway;
      },
    });
    await agent.startup();

    const message = {
      id: "1542925450790305911",
      channel_id: cfg.channelIds[0],
      guild_id: cfg.guildIds[0],
      content: `<@${cfg.applicationId}> do not run`,
      author: { id: "1542925450790305909", username: "jack" },
      member: { roles: cfg.roleIds },
      mentions: [{ id: cfg.applicationId, username: "OpenSession", bot: true }],
      attachments: [],
    };
    dispatch("MESSAGE_CREATE", {
      ...message,
      id: "1542925450790305912",
      guild_id: "1542925450790305999",
    });
    dispatch("MESSAGE_CREATE", {
      ...message,
      id: "1542925450790305913",
      channel_id: "1542925450790305998",
    });
    dispatch("MESSAGE_CREATE", {
      ...message,
      id: "1542925450790305914",
      author: { id: "1542925450790305997", username: "non-team" },
      member: { roles: ["1542925450790305996"] },
    });
    await Bun.sleep(30);
    expect(creates).toBe(0);

    dispatch("INTERACTION_CREATE", {
      id: "1542925450790305915",
      token: "interaction-token",
      type: 2,
      guild_id: cfg.guildIds[0],
      channel_id: cfg.channelIds[0],
      member: {
        user: { id: "1542925450790305997", username: "non-team" },
        roles: ["1542925450790305996"],
      },
      data: { name: "os", options: [{ type: 1, name: "status" }] },
    });
    for (let i = 0; i < 100 && !callbacks.length; i++) await Bun.sleep(5);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0][2]).toMatchObject({
      type: 4,
      data: { flags: 64 },
    });
    expect(callbacks[0][2].data.content).toContain("not enabled for you");
    expect(creates).toBe(0);
    await agent.shutdown();
  });

  test("surfaces a new terminal run error promptly and deduplicates the event", async () => {
    const state = new DiscordStateStore(join(tempDir(), "state.json"));
    const edits: string[] = [];
    const cfg = config();
    let dispatch: (name: string, data: any) => void = () => {};
    const control: SessionControl = {
      listSessions: () => [],
      getSession: (id) =>
        ({
          id,
          state: "idle",
          title: "Failed Discord request",
          lastRunError: {
            message: "Grok subscription sign-in expired; run grok login again",
            at: "2026-08-29T07:47:04.380Z",
          },
        }) as any,
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async () => ({ status: "started", message: "started" }),
      cancelSession: () => false,
      createSession: async () => ({
        id: "os-discord-failed",
        createdBy: "Mattia",
        createdAt: new Date().toISOString(),
      }),
    };
    const rest = {
      currentBot: async () => ({
        id: cfg.applicationId,
        username: "OpenSession",
      }),
      currentGuilds: async () => [{ id: cfg.guildIds[0], name: "Schematik" }],
      syncGuildCommand: async () => ({}),
      gatewayBot: async () => ({ url: "wss://gateway.discord.gg", shards: 1 }),
      channel: async (id: string) => ({ id, type: 0 }),
      startThread: async () => ({ id: "1542925450790305927", type: 11 }),
      sendMessage: async (channelId: string, content: string) => ({
        id: "status",
        channel_id: channelId,
        content,
      }),
      editMessage: async (
        _channelId: string,
        _messageId: string,
        content: string,
      ) => {
        edits.push(content);
        return { id: "status", channel_id: "1542925450790305927", content };
      },
    };
    const agent = new DiscordAgent({
      loadConfig: () => cfg,
      state,
      control: () => control,
      rest: () => rest as unknown as DiscordRest,
      gateway: (options) => {
        dispatch = (name, data) => void options.onDispatch(name, data);
        return {
          start() {},
          stop() {},
          health: () => ({ status: "ready", ready: true }),
        } as unknown as DiscordGateway;
      },
    });
    await agent.startup();
    const event = {
      id: "1542925450790305926",
      channel_id: "1542925450790305925",
      guild_id: cfg.guildIds[0],
      content: `<@${cfg.applicationId}> test`,
      author: { id: cfg.userIds[0], username: "mattia" },
      mentions: [{ id: cfg.applicationId, username: "OpenSession", bot: true }],
      attachments: [],
    };
    dispatch("MESSAGE_CREATE", event);
    for (let i = 0; i < 100 && !state.wasProcessed(event.id); i++)
      await Bun.sleep(5);
    expect(state.wasProcessed(event.id)).toBe(true);
    expect(edits.at(-1)).toBe(
      "OpenSession failed: Grok subscription sign-in expired; run grok login again",
    );
    expect(edits.some((value) => value.includes("idle"))).toBe(false);
    await agent.shutdown();
  });

  test("runs status, model, stop, and new slash commands on one durable link", async () => {
    const state = new DiscordStateStore(join(tempDir(), "state.json"));
    const cfg = config();
    const channelId = "1542925450790305910";
    const key = `guild:${cfg.guildIds[0]}:channel:${channelId}`;
    state.setConversation(key, {
      sessionId: "os-discord-command",
      mode: "code",
      model: "grok/grok-4.6",
      userId: cfg.userIds[0],
      updatedAt: new Date().toISOString(),
    });
    const callbacks: any[] = [];
    const deliveries: string[] = [];
    const cancellations: string[] = [];
    let dispatch: (name: string, data: any) => void = () => {};
    const control: SessionControl = {
      listSessions: () => [],
      getSession: (id) =>
        ({
          id,
          state: "idle",
          title: "Discord command session",
          model: state.conversation(key)?.model,
        }) as any,
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async (_id, prompt) => {
        deliveries.push(prompt);
        return { status: "started", message: "started" };
      },
      cancelSession: (id) => {
        cancellations.push(id);
        return true;
      },
      createSession: async () => ({
        id: "not-used",
        createdBy: "test",
        createdAt: new Date().toISOString(),
      }),
    };
    const rest = {
      currentBot: async () => ({
        id: cfg.applicationId,
        username: "OpenSession",
      }),
      currentGuilds: async () => [{ id: cfg.guildIds[0], name: "Schematik" }],
      syncGuildCommand: async () => ({}),
      gatewayBot: async () => ({ url: "wss://gateway.discord.gg", shards: 1 }),
      interactionCallback: async (...args: any[]) => {
        callbacks.push(args);
      },
    };
    const agent = new DiscordAgent({
      loadConfig: () => cfg,
      state,
      control: () => control,
      rest: () => rest as unknown as DiscordRest,
      gateway: (options) => {
        dispatch = (name, data) => void options.onDispatch(name, data);
        return {
          start() {},
          stop() {},
          health: () => ({ status: "ready", ready: true }),
        } as unknown as DiscordGateway;
      },
    });
    await agent.startup();

    const runCommand = async (
      id: string,
      name: string,
      options: Array<Record<string, unknown>> = [],
    ) => {
      dispatch("INTERACTION_CREATE", {
        id,
        token: `token-${id}`,
        type: 2,
        guild_id: cfg.guildIds[0],
        channel_id: channelId,
        member: { user: { id: cfg.userIds[0], username: "jack" } },
        data: {
          name: "os",
          options: [{ type: 1, name, options }],
        },
      });
      for (let i = 0; i < 100 && !state.wasProcessed(id); i++)
        await Bun.sleep(5);
      expect(state.wasProcessed(id)).toBe(true);
      return callbacks.at(-1)?.[2];
    };

    expect(
      (await runCommand("1542925450790305920", "status")).data.content,
    ).toContain("Discord command session");
    expect(
      (
        await runCommand("1542925450790305921", "model", [
          { type: 3, name: "model", value: "cursor/auto" },
        ])
      ).data.content,
    ).toContain("cursor/auto");
    expect(deliveries).toEqual(["/model cursor/auto"]);
    expect(state.conversation(key)?.model).toBe("cursor/auto");
    expect((await runCommand("1542925450790305922", "stop")).data.content).toBe(
      "Stop requested.",
    );
    expect(cancellations).toEqual(["os-discord-command"]);
    expect(
      (await runCommand("1542925450790305923", "new")).data.content,
    ).toContain("unlinked");
    expect(state.conversation(key)).toBeUndefined();
    expect(callbacks.every((row) => row[2].data.flags === 64)).toBe(true);
    await agent.shutdown();
  });
});
