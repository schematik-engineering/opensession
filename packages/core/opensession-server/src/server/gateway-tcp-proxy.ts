import { createConnection, createServer, type Socket } from "node:net";

type RelaySocket = import("bun").Socket<unknown>;

export type GatewayTcpProxy = {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
};

type ClientState = {
  closed: boolean;
  pending: boolean;
  acceptedAt: number;
  peer?: RelaySocket;
  retry?: ReturnType<typeof setTimeout>;
  requestChunks: Buffer[];
  requestBytes: number;
  fallbackServed: boolean;
};

export type GatewayTcpProxyMetrics = {
  accepted: number;
  connected: number;
  retries: number;
  timedOut: number;
  closed: number;
  pending: number;
  active: number;
  maxConnectWaitMs: number;
  fallbackServed: number;
};

export function createGatewayTcpProxyMetrics(): GatewayTcpProxyMetrics {
  return {
    accepted: 0,
    connected: 0,
    retries: 0,
    timedOut: 0,
    closed: 0,
    pending: 0,
    active: 0,
    maxConnectWaitMs: 0,
    fallbackServed: 0,
  };
}

export interface GatewayTcpProxyOptions {
  hostname: string;
  port: number;
  backendPort(): number;
  retryMs?: number;
  connectDeadlineMs?: number;
  metrics?: GatewayTcpProxyMetrics;
  /** Optional stable HTTP response before a replaceable backend is connected. */
  fallbackHttp?(request: Buffer): Buffer | null;
  /** systemd socket-activation descriptor. PID 1 retains the listening socket. */
  listenFd?: number;
}

/**
 * Stable byte-for-byte TCP front door for gateway children. It deliberately
 * knows nothing about HTTP or WebSockets, so upgrades, streaming bodies and
 * long-lived sockets retain their native semantics. Connections accepted
 * during the child cut-over stay paused until the activated child binds.
 */
function startInheritedGatewayTcpProxy(
  options: GatewayTcpProxyOptions & { listenFd: number },
): GatewayTcpProxy {
  const retryMs = options.retryMs ?? 25;
  const connectDeadlineMs = options.connectDeadlineMs ?? 30_000;
  const metrics = options.metrics ?? createGatewayTcpProxyMetrics();
  const pending = new Set<{
    client: Socket;
    timer?: ReturnType<typeof setTimeout>;
    acceptedAt: number;
    chunks: Buffer[];
    bytes: number;
    served: boolean;
  }>();
  const active = new Set<Socket>();

  const server = createServer({ pauseOnConnect: true }, (client) => {
    const state = {
      client,
      acceptedAt: Date.now(),
      chunks: [],
      bytes: 0,
      served: false,
    } as {
      client: Socket;
      timer?: ReturnType<typeof setTimeout>;
      acceptedAt: number;
      chunks: Buffer[];
      bytes: number;
      served: boolean;
    };
    pending.add(state);
    metrics.accepted++;
    metrics.pending++;
    const deadline = Date.now() + connectDeadlineMs;
    const onData = (chunk: Buffer) => {
      if (state.served) return;
      state.chunks.push(chunk);
      state.bytes += chunk.byteLength;
      const request = Buffer.concat(state.chunks, state.bytes);
      let fallback: Buffer | null | undefined;
      try {
        fallback = options.fallbackHttp?.(request);
      } catch (error) {
        console.error("[gateway-proxy] stable HTTP fallback failed", error);
      }
      if (fallback) {
        state.served = true;
        if (state.timer) clearTimeout(state.timer);
        if (pending.delete(state)) metrics.pending--;
        metrics.fallbackServed++;
        client.end(fallback);
        return;
      }
      if (state.bytes >= 64 * 1024) client.pause();
    };
    client.on("data", onData);
    client.resume();
    const connect = () => {
      if (client.destroyed || state.served) return;
      if (Date.now() >= deadline) {
        pending.delete(state);
        metrics.pending--;
        metrics.timedOut++;
        client.destroy();
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port: options.backendPort() });
      const retry = () => {
        upstream.destroy();
        if (client.destroyed || state.served) return;
        metrics.retries++;
        state.timer = setTimeout(connect, retryMs);
        state.timer.unref?.();
      };
      upstream.once("error", retry);
      upstream.once("connect", () => {
        upstream.removeListener("error", retry);
        if (state.served) {
          upstream.destroy();
          return;
        }
        pending.delete(state);
        metrics.pending--;
        metrics.connected++;
        metrics.active++;
        metrics.maxConnectWaitMs = Math.max(
          metrics.maxConnectWaitMs,
          Date.now() - state.acceptedAt,
        );
        active.add(client);
        active.add(upstream);
        client.removeListener("data", onData);
        if (state.bytes > 0) upstream.write(Buffer.concat(state.chunks, state.bytes));
        state.chunks = [];
        state.bytes = 0;
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        const close = () => {
          if (!active.delete(client)) return;
          active.delete(upstream);
          metrics.active--;
          metrics.closed++;
          client.destroy();
          upstream.destroy();
        };
        client.once("close", close);
        upstream.once("close", close);
      });
    };
    client.once("close", () => {
      if (pending.delete(state)) {
        metrics.pending--;
        metrics.closed++;
      }
      if (state.timer) clearTimeout(state.timer);
    });
    state.timer = setTimeout(() => {
      state.timer = undefined;
      connect();
    }, options.fallbackHttp ? 2 : 0);
    state.timer.unref?.();
  });
  server.listen({ fd: options.listenFd });
  return {
    port: options.port,
    stop(closeActiveConnections = false) {
      server.close();
      if (closeActiveConnections) {
        for (const state of pending) state.client.destroy();
        pending.clear();
        for (const socket of active) socket.destroy();
        active.clear();
      }
    },
  };
}

export function startGatewayTcpProxy(
  options: GatewayTcpProxyOptions,
): GatewayTcpProxy {
  if (options.listenFd !== undefined) {
    return startInheritedGatewayTcpProxy(
      options as GatewayTcpProxyOptions & { listenFd: number },
    );
  }
  const retryMs = options.retryMs ?? 25;
  const connectDeadlineMs = options.connectDeadlineMs ?? 30_000;
  const clients = new WeakMap<RelaySocket, ClientState>();
  const peers = new WeakMap<RelaySocket, RelaySocket>();
  const metrics = options.metrics ?? createGatewayTcpProxyMetrics();

  const close = (socket: RelaySocket) => {
    const state = clients.get(socket);
    if (state && !state.closed) {
      state.closed = true;
      metrics.closed++;
      if (state.pending) {
        state.pending = false;
        metrics.pending--;
      }
      if (state.peer) metrics.active--;
      if (state.retry) clearTimeout(state.retry);
    }
    const peer = peers.get(socket);
    peers.delete(socket);
    if (peer) {
      peers.delete(peer);
      try { peer.end(); } catch {}
    }
  };

  const forward = (source: RelaySocket, data: Uint8Array<ArrayBufferLike>) => {
    const peer = peers.get(source);
    if (!peer) return;
    const written = peer.write(data as unknown as Uint8Array<ArrayBuffer>);
    const length = data.byteLength;
    if (written < length) source.pause();
  };

  const connect = (client: RelaySocket, deadline: number) => {
    const state = clients.get(client);
    if (!state || state.closed || state.peer || state.fallbackServed) return;
    const retry = () => {
      if (state.closed || state.peer || state.retry || state.fallbackServed) return;
      if (Date.now() >= deadline) {
        metrics.timedOut++;
        if (state.pending) {
          state.pending = false;
          metrics.pending--;
        }
        try { client.end(); } catch {}
        return;
      }
      metrics.retries++;
      state.retry = setTimeout(() => {
        state.retry = undefined;
        connect(client, deadline);
      }, retryMs);
      state.retry.unref?.();
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port: options.backendPort(),
      socket: {
        open(upstream) {
          if (state.closed || state.fallbackServed) {
            upstream.end();
            return;
          }
          state.peer = upstream;
          if (state.pending) {
            state.pending = false;
            metrics.pending--;
          }
          metrics.connected++;
          metrics.active++;
          metrics.maxConnectWaitMs = Math.max(
            metrics.maxConnectWaitMs,
            Date.now() - state.acceptedAt,
          );
          peers.set(client, upstream);
          peers.set(upstream, client);
          if (state.requestBytes > 0) {
            upstream.write(Buffer.concat(state.requestChunks, state.requestBytes));
            state.requestChunks = [];
            state.requestBytes = 0;
          }
          client.resume();
        },
        data(upstream, data) {
          forward(upstream, data);
        },
        drain(upstream) {
          peers.get(upstream)?.resume();
        },
        close(upstream) {
          const downstream = peers.get(upstream);
          peers.delete(upstream);
          if (downstream) {
            peers.delete(downstream);
            const downstreamState = clients.get(downstream);
            if (downstreamState?.peer) {
              downstreamState.peer = undefined;
              metrics.active--;
            }
            try { downstream.end(); } catch {}
          }
        },
        connectError() {
          retry();
        },
        error() {
          retry();
        },
      },
    }).catch(retry);
  };

  return Bun.listen({
    hostname: options.hostname,
    port: options.port,
    socket: {
      open(client) {
        const state: ClientState = {
          closed: false,
          pending: true,
          acceptedAt: Date.now(),
          requestChunks: [],
          requestBytes: 0,
          fallbackServed: false,
        };
        clients.set(client, state);
        metrics.accepted++;
        metrics.pending++;
        state.retry = setTimeout(() => {
          state.retry = undefined;
          connect(client, Date.now() + connectDeadlineMs);
        }, options.fallbackHttp ? 2 : 0);
        state.retry.unref?.();
      },
      data(client, data) {
        const state = clients.get(client);
        if (!state || state.closed || state.fallbackServed) return;
        if (state.peer) {
          forward(client, data);
          return;
        }
        const chunk = Buffer.from(data);
        state.requestChunks.push(chunk);
        state.requestBytes += chunk.byteLength;
        let fallback: Buffer | null | undefined;
        try {
          fallback = options.fallbackHttp?.(
            Buffer.concat(state.requestChunks, state.requestBytes),
          );
        } catch (error) {
          console.error("[gateway-proxy] stable HTTP fallback failed", error);
        }
        if (fallback) {
          state.fallbackServed = true;
          metrics.fallbackServed++;
          if (state.pending) {
            state.pending = false;
            metrics.pending--;
          }
          if (state.retry) clearTimeout(state.retry);
          client.write(fallback);
          client.end();
        } else if (state.requestBytes >= 64 * 1024) {
          client.pause();
        }
      },
      drain(client) {
        peers.get(client)?.resume();
      },
      close(client) {
        close(client);
      },
      error(client) {
        close(client);
      },
    },
  });
}
