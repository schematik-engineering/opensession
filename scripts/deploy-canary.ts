#!/usr/bin/env bun

import { renameSync, writeFileSync } from "node:fs";

const [httpUrl = "http://127.0.0.1:3850/live", output = "/tmp/opensession-deploy-canary.json"] =
  process.argv.slice(2);
const wsUrl = new URL(httpUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";

const startedAt = new Date().toISOString();
const metrics = {
  httpAttempts: 0,
  httpFailures: 0,
  httpMaxMs: 0,
  websocketOpens: 0,
  websocketCloses: 0,
  websocketErrors: 0,
};
let stopping = false;
let websocket: WebSocket | null = null;

function persist(): void {
  const next = `${output}.${process.pid}.tmp`;
  writeFileSync(
    next,
    `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), ...metrics }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(next, output);
}

async function probeHttp(): Promise<void> {
  while (!stopping) {
    const started = performance.now();
    metrics.httpAttempts++;
    try {
      const response = await fetch(httpUrl, { signal: AbortSignal.timeout(30_000) });
      await response.arrayBuffer();
      if (!response.ok) metrics.httpFailures++;
    } catch {
      metrics.httpFailures++;
    }
    metrics.httpMaxMs = Math.max(metrics.httpMaxMs, Math.round(performance.now() - started));
    await Bun.sleep(25);
  }
}

function connectWebSocket(): void {
  if (stopping) return;
  const socket = new WebSocket(wsUrl.toString());
  websocket = socket;
  socket.addEventListener("open", () => metrics.websocketOpens++);
  socket.addEventListener("error", () => metrics.websocketErrors++);
  socket.addEventListener("close", () => {
    metrics.websocketCloses++;
    if (websocket === socket) websocket = null;
    if (!stopping) setTimeout(connectWebSocket, 250).unref?.();
  });
}

const stop = () => {
  if (stopping) return;
  stopping = true;
  websocket?.close();
  persist();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
connectWebSocket();
await probeHttp();
