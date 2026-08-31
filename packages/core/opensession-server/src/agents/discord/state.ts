import { existsSync, readFileSync } from "fs";
import { stateDir } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";

export interface DiscordConversation {
  sessionId: string;
  model?: string;
  mode: "code";
  userId: string;
  updatedAt: string;
  /** Intake event whose createSession call already supplied the opening prompt. */
  openingEventId?: string;
}

export interface DiscordGatewayCheckpoint {
  sessionId?: string;
  resumeGatewayUrl?: string;
  seq?: number;
}

export interface DiscordPendingMessage {
  id: string;
  receivedAt: string;
  message: unknown;
}

interface PersistedDiscordState {
  version: 1;
  gateway: DiscordGatewayCheckpoint;
  conversations: Record<string, DiscordConversation>;
  pendingMessages: Record<string, DiscordPendingMessage>;
  processed: Record<string, string>;
}

const EMPTY_STATE: PersistedDiscordState = {
  version: 1,
  gateway: {},
  conversations: {},
  pendingMessages: {},
  processed: {},
};

const MAX_PROCESSED = 5_000;
const MAX_PENDING_MESSAGES = 1_000;
const PROCESSED_TTL_MS = 14 * 24 * 60 * 60_000;

function validConversation(value: unknown): value is DiscordConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    v.mode === "code" &&
    typeof v.userId === "string" &&
    typeof v.updatedAt === "string" &&
    (v.model === undefined || typeof v.model === "string") &&
    (v.openingEventId === undefined || typeof v.openingEventId === "string")
  );
}

function validPendingMessage(value: unknown): value is DiscordPendingMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.receivedAt === "string" &&
    !!v.message &&
    typeof v.message === "object" &&
    !Array.isArray(v.message)
  );
}

function parseState(raw: unknown): PersistedDiscordState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return structuredClone(EMPTY_STATE);
  }
  const value = raw as Record<string, unknown>;
  const gatewayValue =
    value.gateway && typeof value.gateway === "object"
      ? (value.gateway as Record<string, unknown>)
      : {};
  const conversations: Record<string, DiscordConversation> = {};
  if (value.conversations && typeof value.conversations === "object") {
    for (const [key, conversation] of Object.entries(value.conversations)) {
      if (key && validConversation(conversation))
        conversations[key] = conversation;
    }
  }
  const processed: Record<string, string> = {};
  if (value.processed && typeof value.processed === "object") {
    for (const [id, at] of Object.entries(value.processed)) {
      if (id && typeof at === "string") processed[id] = at;
    }
  }
  const pendingMessages: Record<string, DiscordPendingMessage> = {};
  if (value.pendingMessages && typeof value.pendingMessages === "object") {
    for (const [id, pending] of Object.entries(value.pendingMessages)) {
      if (id && validPendingMessage(pending) && pending.id === id) {
        pendingMessages[id] = pending;
      }
    }
  }
  return {
    version: 1,
    gateway: {
      ...(typeof gatewayValue.sessionId === "string"
        ? { sessionId: gatewayValue.sessionId }
        : {}),
      ...(typeof gatewayValue.resumeGatewayUrl === "string"
        ? { resumeGatewayUrl: gatewayValue.resumeGatewayUrl }
        : {}),
      ...(typeof gatewayValue.seq === "number" && gatewayValue.seq >= 0
        ? { seq: gatewayValue.seq }
        : {}),
    },
    conversations,
    pendingMessages,
    processed,
  };
}

/** Durable Discord dedup, gateway resume, and channel → OpenSession linkage. */
export class DiscordStateStore {
  private state: PersistedDiscordState;

  constructor(private readonly path = stateDir("discord/state.json")) {
    try {
      this.state = existsSync(path)
        ? parseState(JSON.parse(readFileSync(path, "utf8")))
        : structuredClone(EMPTY_STATE);
    } catch {
      this.state = structuredClone(EMPTY_STATE);
    }
    this.prunePendingMessages();
    this.pruneProcessed(false);
  }

  gateway(): DiscordGatewayCheckpoint {
    return { ...this.state.gateway };
  }

  setGateway(value: DiscordGatewayCheckpoint): void {
    this.state.gateway = { ...value };
  }

  conversation(key: string): DiscordConversation | undefined {
    const value = this.state.conversations[key];
    return value ? { ...value } : undefined;
  }

  setConversation(key: string, value: DiscordConversation): void {
    this.state.conversations[key] = { ...value };
    this.save();
  }

  deleteConversation(key: string): void {
    if (!this.state.conversations[key]) return;
    delete this.state.conversations[key];
    this.save();
  }

  pendingMessage(id: string): DiscordPendingMessage | undefined {
    const value = this.state.pendingMessages[id];
    return value ? structuredClone(value) : undefined;
  }

  pendingMessages(): DiscordPendingMessage[] {
    return Object.values(this.state.pendingMessages)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
      .map((value) => structuredClone(value));
  }

  pendingMessageCount(): number {
    return Object.keys(this.state.pendingMessages).length;
  }

  enqueueMessage(id: string, message: unknown): void {
    if (this.state.pendingMessages[id] || this.state.processed[id]) return;
    this.prunePendingMessages();
    if (this.pendingMessageCount() >= MAX_PENDING_MESSAGES) {
      throw new Error("Discord pending message queue is full");
    }
    this.state.pendingMessages[id] = {
      id,
      receivedAt: new Date().toISOString(),
      message: structuredClone(message),
    };
    this.save();
  }

  wasProcessed(id: string): boolean {
    return !!this.state.processed[id];
  }

  markProcessed(id: string): void {
    this.state.processed[id] = new Date().toISOString();
    delete this.state.pendingMessages[id];
    for (const [key, conversation] of Object.entries(
      this.state.conversations,
    )) {
      if (conversation.openingEventId === id) {
        const settled = { ...conversation };
        delete settled.openingEventId;
        this.state.conversations[key] = settled;
      }
    }
    this.pruneProcessed(false);
    this.save();
  }

  save(): void {
    writeJsonAtomic(this.path, this.state, true, 0o600);
  }

  private pruneProcessed(save: boolean): void {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    const entries = Object.entries(this.state.processed)
      .filter(([, at]) => Date.parse(at) >= cutoff)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .slice(0, MAX_PROCESSED);
    if (entries.length === Object.keys(this.state.processed).length) return;
    this.state.processed = Object.fromEntries(entries);
    if (save) this.save();
  }

  private prunePendingMessages(): void {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    this.state.pendingMessages = Object.fromEntries(
      Object.entries(this.state.pendingMessages)
        .filter(([, value]) => Date.parse(value.receivedAt) >= cutoff)
        .sort(
          (a, b) => Date.parse(b[1].receivedAt) - Date.parse(a[1].receivedAt),
        ),
    );
  }
}
