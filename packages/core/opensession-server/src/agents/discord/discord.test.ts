import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SessionControl } from "../../server/session-control";
import { DiscordRest, splitDiscordMessage } from "./api";
import { loadDiscordConfig, type DiscordConfig } from "./config";
import { DiscordGateway } from "./gateway";
import { DiscordAgent } from "./index";
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
    userIds: [],
    defaultModel: "grok/grok-4.6",
    sandbox: "docker",
    responseTimeoutMs: 30_000,
    ...overrides,
  };
}

describe("Discord config and state", () => {
  test("requires an explicit guild allowlist and reads a mode-0600 token file", () => {
    const dir = tempDir();
    const tokenFile = join(dir, "bot-token");
    writeFileSync(tokenFile, "secret-value\n", { mode: 0o600 });
    process.env.DISCORD_APPLICATION_ID = "1542925450790305903";
    process.env.DISCORD_BOT_TOKEN_FILE = tokenFile;
    process.env.DISCORD_GUILD_IDS = "1542925450790305904";
    delete process.env.DISCORD_BOT_TOKEN;
    const loaded = loadDiscordConfig();
    expect(loaded.token).toBe("secret-value");
    expect(loaded.guildIds).toEqual(["1542925450790305904"]);

    delete process.env.DISCORD_GUILD_IDS;
    expect(() => loadDiscordConfig()).toThrow("fails closed");
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
      mode: "ask",
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
});

describe("Discord REST presentation", () => {
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
});

describe("Discord agent", () => {
  test("turns an allowed mention into one Docker-backed native session and deduplicates it", async () => {
    const state = new DiscordStateStore(join(tempDir(), "state.json"));
    const edits: string[] = [];
    const creates: any[] = [];
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
      transcriptTail: async () => [
        {
          id: "answer",
          type: "assistant",
          content: "GROK_DISCORD_OK",
          timestamp: new Date().toISOString(),
        },
      ],
      answerQuestion: () => false,
      deliverToSession: async () => ({ status: "started", message: "started" }),
      cancelSession: () => true,
      createSession: async (input) => {
        creates.push(input);
        return {
          id: "os-discord-1",
          createdBy: String(input.user),
          createdAt: new Date().toISOString(),
        };
      },
    };
    const rest = {
      currentBot: async () => ({
        id: config().applicationId,
        username: "OpenSession",
      }),
      currentGuilds: async () => [
        { id: config().guildIds[0], name: "Schematik" },
      ],
      syncGuildCommand: async () => ({}),
      gatewayBot: async () => ({ url: "wss://gateway.discord.gg", shards: 1 }),
      startThread: async () => ({ id: "1542925450790305906", type: 11 }),
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
        return { id: "status", channel_id: "1542925450790305906", content };
      },
    };
    const agent = new DiscordAgent({
      loadConfig: config,
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
      channel_id: "1542925450790305908",
      guild_id: config().guildIds[0],
      content: `<@${config().applicationId}> use Grok`,
      author: { id: "1542925450790305909", username: "jack" },
      mentions: [
        { id: config().applicationId, username: "OpenSession", bot: true },
      ],
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
      mode: "ask",
      sandbox: "docker",
      requestId: `discord:${event.id}:create`,
    });
    expect(edits.at(-1)).toContain("GROK_DISCORD_OK");

    dispatch("MESSAGE_CREATE", event);
    await Bun.sleep(20);
    expect(creates).toHaveLength(1);
    await agent.shutdown();
  });
});
