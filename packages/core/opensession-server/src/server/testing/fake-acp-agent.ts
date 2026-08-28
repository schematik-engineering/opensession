/** Deterministic stdio ACP peer for acp-runner integration tests. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { createInterface } from "readline";

const provider = process.argv[2] || "grok";
let nextRequestId = 10_000;
const pending = new Map<number, (value: any) => void>();
const promptRequests = new Map<string, number>();

function authPath(): string {
  return join(
    process.env.HOME || "",
    provider === "grok" ? ".grok/auth.json" : ".config/cursor/auth.json",
  );
}

function sessionStatePath(sessionId: string): string {
  const root = join(
    process.env.HOME || "",
    provider === "grok" ? ".grok/sessions" : ".cursor/acp-sessions",
  );
  return join(root, `${sessionId}.state`);
}

function persistSession(sessionId: string): void {
  const destination = sessionStatePath(sessionId);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, "provider-native-session-state", {
    mode: 0o600,
  });
}

function hasCredentialArtifacts(): boolean {
  const auth = authPath();
  try {
    const name = auth.slice(auth.lastIndexOf("/") + 1);
    return readdirSync(dirname(auth)).some(
      (entry) => entry === name || entry.startsWith(`${name}.`),
    );
  } catch {
    return false;
  }
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id: string | number, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function request(method: string, params: unknown): Promise<any> {
  const id = nextRequestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function update(sessionId: string, value: Record<string, unknown>): void {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}

const models =
  provider === "cursor"
    ? {
        currentModelId: "default[]",
        availableModels: [
          { modelId: "default[]", name: "Auto" },
          { modelId: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" },
        ],
      }
    : {
        currentModelId: "grok-4.6",
        availableModels: [
          { modelId: "grok-4.6", name: "Grok 4.6" },
          { modelId: "grok-4.5", name: "Grok 4.5" },
        ],
      };

const cursorSetup = {
  modes: {
    currentModeId: "agent",
    availableModes: [
      { id: "agent", name: "Agent" },
      { id: "ask", name: "Ask" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "default[]",
      options: [
        { value: "default[]", name: "Auto" },
        { value: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" },
      ],
    },
  ],
};

async function runPrompt(id: number, params: any): Promise<void> {
  const sessionId = String(params.sessionId);
  promptRequests.set(sessionId, id);
  const text = String(
    params.prompt?.find((part: any) => part.type === "text")?.text || "",
  );
  if (text === "malformed") {
    process.stdout.write("this is not json\n");
    setTimeout(() => process.exit(2), 10);
    return;
  }
  if (text === "hang") return;
  if (text === "usage failure") {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "subscription usage limit exhausted" },
    });
    return;
  }
  if (hasCredentialArtifacts()) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "credential artifacts not scrubbed" },
    });
    return;
  }

  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Check credential boundary",
    name: "terminal",
    kind: "execute",
    status: "pending",
    rawInput: { command: "credential boundary probe" },
  });
  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "tool-1",
      title: "Check credential boundary",
      name: "terminal",
    },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  let terminalOutput = `permission:${permission?.outcome?.outcome || "unknown"}`;
  if (provider === "grok" && permission?.outcome?.optionId === "allow") {
    const created = await request("terminal/create", {
      sessionId,
      command: "sh",
      args: [
        "-c",
        'test ! -e "$HOME/.grok/auth.json" && test -z "$OPENSESSION_ACP_BOOTSTRAP_FILE" && printf credential-scrubbed',
      ],
      cwd: process.cwd(),
      outputByteLimit: 4096,
    });
    await request("terminal/wait_for_exit", {
      sessionId,
      terminalId: created.terminalId,
    });
    const output = await request("terminal/output", {
      sessionId,
      terminalId: created.terminalId,
    });
    terminalOutput = output.output;
    await request("terminal/release", {
      sessionId,
      terminalId: created.terminalId,
    });
  }
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    rawOutput: terminalOutput,
  });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: "message-1",
    content: { type: "text", text: "hello " },
  });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: "message-1",
    content: { type: "text", text: "from ACP" },
  });
  promptRequests.delete(sessionId);
  result(id, {
    stopReason: "end_turn",
    usage: {
      totalTokens: 18,
      inputTokens: 10,
      outputTokens: 8,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && !message.method) {
    pending.get(Number(message.id))?.(message.result);
    pending.delete(Number(message.id));
    return;
  }
  const id = message.id;
  const params = message.params || {};
  switch (message.method) {
    case "initialize":
      result(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: provider === "cursor" },
        },
        authMethods: [
          {
            id: provider === "cursor" ? "cursor_login" : "cached_token",
            name: "Subscription",
          },
        ],
      });
      break;
    case "authenticate":
      if (!existsSync(authPath())) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "subscription auth missing" },
        });
        break;
      }
      writeFileSync(
        `${authPath()}.fake.tmp`,
        readFileSync(authPath(), "utf8"),
        { mode: 0o600 },
      );
      result(id, {});
      break;
    case "session/new": {
      const sessionId = `${provider}-session-new`;
      persistSession(sessionId);
      result(id, {
        sessionId,
        models,
        ...(provider === "cursor" ? cursorSetup : {}),
      });
      break;
    }
    case "session/load":
      if (!existsSync(sessionStatePath(String(params.sessionId)))) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: provider === "grok" ? "Path not found" : "Invalid params",
          },
        });
        break;
      }
      update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "replayed-old-message",
        content: { type: "text", text: "old history" },
      });
      result(id, { models, ...(provider === "cursor" ? cursorSetup : {}) });
      break;
    case "session/resume":
      if (!existsSync(sessionStatePath(String(params.sessionId)))) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Path not found" },
        });
        break;
      }
      result(id, {});
      break;
    case "session/set_model":
    case "session/set_config_option":
    case "session/set_mode":
      result(id, { configOptions: cursorSetup.configOptions });
      break;
    case "session/prompt":
      void runPrompt(Number(id), params);
      break;
    case "session/cancel": {
      const promptId = promptRequests.get(String(params.sessionId));
      if (promptId !== undefined) {
        promptRequests.delete(String(params.sessionId));
        result(promptId, { stopReason: "cancelled" });
      }
      break;
    }
  }
});
