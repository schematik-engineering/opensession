#!/usr/bin/env bun
/** One real subscription-backed ACP turn. Credential staging is operator-owned. */
import { runAcp } from "../packages/core/opensession-server/src/server/acp-runner";

const provider = process.argv[2];
if (provider !== "grok" && provider !== "cursor") {
  console.error("usage: verify-acp-provider.ts <grok|cursor> [model]");
  process.exit(2);
}
const model =
  process.argv[3] || (provider === "grok" ? "grok/grok-4.6" : "cursor/auto");
const expected = provider === "grok" ? "GROK_ACP_OK" : "CURSOR_ACP_OK";
const events: Array<Record<string, unknown>> = [];
for await (const event of runAcp(
  {
    prompt: `Reply with exactly: ${expected}`,
    cwd: process.cwd(),
    mode: "ask",
    model,
    mcpServers: [],
    startToken: `verify-${provider}-${crypto.randomUUID()}`,
  },
  model,
)) {
  events.push({
    type: event.type,
    text: event.text,
    content: event.content,
    result: event.result,
    sessionId: event.sessionId,
    provider: event.provider,
  });
}
const terminal = events.at(-1);
console.log(JSON.stringify({ provider, model, events }));
const verified =
  terminal?.type === "done" && String(terminal.result || "").includes(expected);

// Runtime imports intentionally keep config watchers alive in the server and
// runner-host. This operator-only one-shot probe must terminate after its
// terminal event instead of waiting on those long-lived handles.
process.exit(verified ? 0 : 1);
