import type { DiscordGatewayCheckpoint } from "./state";

type GatewayPayload = {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
};

export interface DiscordGatewayHealth {
  status: "stopped" | "connecting" | "ready" | "reconnecting" | "fatal";
  ready: boolean;
  resumed: boolean;
  reconnects: number;
  lastEventAt?: string;
  lastHeartbeatAckAt?: string;
  fatalReason?: string;
}

export interface DiscordGatewayOptions {
  token: string;
  intents: number;
  gatewayUrl: string;
  checkpoint: () => DiscordGatewayCheckpoint;
  saveCheckpoint: (value: DiscordGatewayCheckpoint) => void;
  onDispatch: (name: string, data: any) => void | Promise<void>;
  onReady?: (data: any) => void | Promise<void>;
  webSocketFactory?: (url: string) => WebSocket;
  random?: () => number;
}

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const CLEAR_SESSION_CLOSE_CODES = new Set([4007, 4009]);

function textMessage(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer)
    return Promise.resolve(new TextDecoder().decode(data));
  if (ArrayBuffer.isView(data))
    return Promise.resolve(
      new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
    );
  return Promise.reject(new Error("unsupported Gateway message type"));
}

/** Discord Gateway v10 client with heartbeat/ACK, resume, and bounded backoff. */
export class DiscordGateway {
  private socket: WebSocket | null = null;
  private stopped = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private checkpointSaveTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAcked = true;
  private reconnectAttempt = 0;
  private resumeOnNextConnect = true;
  private dispatchQueue = Promise.resolve();
  private state: DiscordGatewayHealth = {
    status: "stopped",
    ready: false,
    resumed: false,
    reconnects: 0,
  };

  constructor(private readonly options: DiscordGatewayOptions) {}

  health(): DiscordGatewayHealth {
    return { ...this.state };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.flushCheckpoint();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, "shutdown");
    this.state = { ...this.state, status: "stopped", ready: false };
  }

  private connect(): void {
    if (this.stopped || this.state.status === "fatal") return;
    this.clearConnectionTimers();
    // A failed dispatch poisons only its WebSocket connection. Later events on
    // that socket must not overtake it, while a reconnect starts a fresh chain
    // and asks Discord to replay from the last durable sequence.
    this.dispatchQueue = Promise.resolve();
    // Heartbeat ACK state belongs to one WebSocket connection. Carrying an
    // unacked heartbeat across reconnect would make the new socket close on
    // its first heartbeat tick before Discord can ACK it.
    this.heartbeatAcked = true;
    this.state = {
      ...this.state,
      status: this.reconnectAttempt ? "reconnecting" : "connecting",
      ready: false,
    };
    const checkpoint = this.options.checkpoint();
    const base =
      this.resumeOnNextConnect && checkpoint.resumeGatewayUrl
        ? checkpoint.resumeGatewayUrl
        : this.options.gatewayUrl;
    const url = new URL(base);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    const socket = (
      this.options.webSocketFactory ?? ((value) => new WebSocket(value))
    )(url.toString());
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      void this.onMessage(event.data).catch((error) => {
        console.error(
          "[discord] Gateway payload failed:",
          error instanceof Error ? error.message : error,
        );
        socket.close(4000, "invalid payload");
      });
    });
    socket.addEventListener("error", () => {
      // The close event owns reconnect. Browsers/Bun expose no safe detail here.
    });
    socket.addEventListener("close", (event) =>
      this.onClose(event.code, event.reason),
    );
  }

  private async onMessage(raw: unknown): Promise<void> {
    const payload = JSON.parse(await textMessage(raw)) as GatewayPayload;
    this.state.lastEventAt = new Date().toISOString();

    switch (payload.op) {
      case 0: {
        const dispatch = this.dispatchQueue.then(async () => {
          await this.onDispatch(payload);
          this.saveSequence(payload.s);
          if (payload.t === "READY" || payload.t === "RESUMED") {
            this.flushCheckpoint();
          }
        });
        this.dispatchQueue = dispatch;
        await dispatch;
        return;
      }
      case 1:
        this.sendHeartbeat();
        return;
      case 7:
        this.resumeOnNextConnect = true;
        this.socket?.close(4000, "server requested reconnect");
        return;
      case 9:
        this.resumeOnNextConnect = payload.d === true;
        if (!this.resumeOnNextConnect) this.clearCheckpoint();
        setTimeout(
          () => this.socket?.close(4000, "invalid session"),
          1_000 +
            Math.floor((this.options.random?.() ?? Math.random()) * 4_000),
        );
        return;
      case 10:
        this.onHello(payload.d);
        return;
      case 11:
        this.heartbeatAcked = true;
        this.state.lastHeartbeatAckAt = new Date().toISOString();
        return;
    }
    this.saveSequence(payload.s);
  }

  private onHello(data: { heartbeat_interval?: number } | undefined): void {
    const interval = Number(data?.heartbeat_interval);
    if (!Number.isFinite(interval) || interval < 1_000) {
      this.socket?.close(4000, "invalid hello");
      return;
    }
    const checkpoint = this.options.checkpoint();
    const canResume =
      this.resumeOnNextConnect &&
      !!checkpoint.sessionId &&
      typeof checkpoint.seq === "number";
    this.send(
      canResume
        ? {
            op: 6,
            d: {
              token: this.options.token,
              session_id: checkpoint.sessionId,
              seq: checkpoint.seq,
            },
          }
        : {
            op: 2,
            d: {
              token: this.options.token,
              intents: this.options.intents,
              properties: {
                os: process.platform,
                browser: "opensession",
                device: "opensession",
              },
            },
          },
    );
    const random = this.options.random?.() ?? Math.random();
    this.heartbeatTimer = setTimeout(
      () => this.heartbeatLoop(interval),
      Math.max(1, Math.floor(interval * random)),
    );
  }

  private heartbeatLoop(interval: number): void {
    if (this.stopped || !this.socket) return;
    if (!this.heartbeatAcked) {
      this.socket.close(4000, "heartbeat ACK timeout");
      return;
    }
    this.sendHeartbeat();
    this.heartbeatTimer = setTimeout(
      () => this.heartbeatLoop(interval),
      interval,
    );
  }

  private sendHeartbeat(): void {
    this.heartbeatAcked = false;
    this.send({ op: 1, d: this.options.checkpoint().seq ?? null });
  }

  private async onDispatch(payload: GatewayPayload): Promise<void> {
    const name = payload.t || "";
    if (name === "READY") {
      const data = payload.d || {};
      this.options.saveCheckpoint({
        sessionId: data.session_id,
        resumeGatewayUrl: data.resume_gateway_url,
      });
      this.reconnectAttempt = 0;
      this.state = {
        ...this.state,
        status: "ready",
        ready: true,
        resumed: false,
      };
      await this.options.onReady?.(data);
    } else if (name === "RESUMED") {
      this.reconnectAttempt = 0;
      this.state = {
        ...this.state,
        status: "ready",
        ready: true,
        resumed: true,
      };
    }
    await this.options.onDispatch(name, payload.d);
  }

  private saveSequence(sequence: number | null | undefined): void {
    if (typeof sequence !== "number") return;
    const checkpoint = this.options.checkpoint();
    this.options.saveCheckpoint({ ...checkpoint, seq: sequence });
    this.scheduleCheckpointSave();
  }

  private onClose(code: number, reason: string): void {
    this.socket = null;
    this.clearConnectionTimers();
    this.flushCheckpoint();
    if (this.stopped) return;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.state = {
        ...this.state,
        status: "fatal",
        ready: false,
        fatalReason: `Gateway closed with ${code}${reason ? ` (${reason})` : ""}`,
      };
      console.error(`[discord] ${this.state.fatalReason}`);
      return;
    }
    if (CLEAR_SESSION_CLOSE_CODES.has(code)) {
      this.resumeOnNextConnect = false;
      this.clearCheckpoint();
    }
    this.reconnectAttempt += 1;
    this.state = {
      ...this.state,
      status: "reconnecting",
      ready: false,
      reconnects: this.state.reconnects + 1,
    };
    const cap = Math.min(
      30_000,
      1_000 * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    const wait = Math.floor(
      cap * (0.5 + (this.options.random?.() ?? Math.random()) * 0.5),
    );
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private send(payload: GatewayPayload): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private clearCheckpoint(): void {
    const seq = this.options.checkpoint().seq;
    this.options.saveCheckpoint(typeof seq === "number" ? { seq } : {});
    this.flushCheckpoint();
  }

  private scheduleCheckpointSave(): void {
    if (this.checkpointSaveTimer) return;
    this.checkpointSaveTimer = setTimeout(() => this.flushCheckpoint(), 5_000);
  }

  private flushCheckpoint(): void {
    if (this.checkpointSaveTimer) clearTimeout(this.checkpointSaveTimer);
    this.checkpointSaveTimer = undefined;
    this.options.saveCheckpoint(this.options.checkpoint());
  }

  private clearConnectionTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearTimers(): void {
    this.clearConnectionTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
