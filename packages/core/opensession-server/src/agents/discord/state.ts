import { existsSync, readFileSync } from "fs";
import { stateDir } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";

export interface DiscordConversation {
  sessionId: string;
  model?: string;
  mode: "ask" | "code";
  userId: string;
  updatedAt: string;
}

export interface DiscordGatewayCheckpoint {
  sessionId?: string;
  resumeGatewayUrl?: string;
  seq?: number;
}

interface PersistedDiscordState {
  version: 1;
  gateway: DiscordGatewayCheckpoint;
  conversations: Record<string, DiscordConversation>;
  processed: Record<string, string>;
}

const EMPTY_STATE: PersistedDiscordState = {
  version: 1,
  gateway: {},
  conversations: {},
  processed: {},
};

const MAX_PROCESSED = 5_000;
const PROCESSED_TTL_MS = 14 * 24 * 60 * 60_000;

function validConversation(value: unknown): value is DiscordConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    (v.mode === "ask" || v.mode === "code") &&
    typeof v.userId === "string" &&
    typeof v.updatedAt === "string" &&
    (v.model === undefined || typeof v.model === "string")
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

  wasProcessed(id: string): boolean {
    return !!this.state.processed[id];
  }

  markProcessed(id: string): void {
    this.state.processed[id] = new Date().toISOString();
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
}
