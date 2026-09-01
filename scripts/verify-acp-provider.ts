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
const probe = process.argv[4] || "prompt";
const elicitation = probe === "elicitation";
const expected = elicitation
  ? "GROK_ACP_ELICIT_OK"
  : provider === "grok"
    ? "GROK_ACP_OK"
    : "CURSOR_ACP_OK";
const events: Array<Record<string, unknown>> = [];
for await (const event of runAcp(
  {
    prompt: elicitation
      ? `Call request_release_label exactly once. After it returns, reply with exactly: ${expected}`
      : `Reply with exactly: ${expected}`,
    cwd: process.cwd(),
    mode: "ask",
    model,
    mcpServers: [],
    inProcessMcp: elicitation
      ? {
          "elicitation-probe": {
            command: process.execPath,
            args: [
              `${process.cwd()}/packages/core/opensession-server/src/server/testing/elicitation-mcp-server.ts`,
            ],
          },
        }
      : undefined,
    startToken: `verify-${provider}-${crypto.randomUUID()}`,
    onAskUser: elicitation
      ? async (input) => {
          const questions = input.questions as
            | Array<{ question?: unknown }>
            | undefined;
          const question = questions?.[0]?.question;
          return {
            behavior: "allow" as const,
            updatedInput: {
              answers: {
                [typeof question === "string" ? question : "Release label"]:
                  "Stable",
              },
            },
          };
        }
      : undefined,
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
