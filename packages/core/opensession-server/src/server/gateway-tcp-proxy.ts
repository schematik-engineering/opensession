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
  };
}

export interface GatewayTcpProxyOptions {
  hostname: string;
  port: number;
  backendPort(): number;
  retryMs?: number;
  connectDeadlineMs?: number;
  metrics?: GatewayTcpProxyMetrics;
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
  const pending = new Set<{ client: Socket; timer?: ReturnType<typeof setTimeout>; acceptedAt: number }>();
  const active = new Set<Socket>();

  const server = createServer({ pauseOnConnect: true }, (client) => {
    const state = { client, acceptedAt: Date.now() } as {
      client: Socket;
      timer?: ReturnType<typeof setTimeout>;
      acceptedAt: number;
    };
    pending.add(state);
    metrics.accepted++;
    metrics.pending++;
    const deadline = Date.now() + connectDeadlineMs;
    const connect = () => {
      if (client.destroyed) return;
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
        if (client.destroyed) return;
        metrics.retries++;
        state.timer = setTimeout(connect, retryMs);
        state.timer.unref?.();
      };
      upstream.once("error", retry);
      upstream.once("connect", () => {
        upstream.removeListener("error", retry);
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
    connect();
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
    if (!state || state.closed || state.peer) return;
    const retry = () => {
      if (state.closed || state.peer || state.retry) return;
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
          if (state.closed) {
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
        };
        clients.set(client, state);
        metrics.accepted++;
        metrics.pending++;
        client.pause();
        connect(client, Date.now() + connectDeadlineMs);
      },
      data(client, data) {
        forward(client, data);
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
