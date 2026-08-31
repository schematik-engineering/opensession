/** Shared ACP adapter for the official Grok and Cursor subscription CLIs. */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { Readable, Writable } from "stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type McpServer,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent } from "./run-events";
import {
  appendTranscriptEntries,
  recordEngineSessionOwner,
  transcriptLineAssistantText,
  transcriptLineRunnerNotice,
  transcriptLineToolResult,
  transcriptLineToolUse,
} from "./transcript-persistence";
import { transcriptForwarder } from "./transcript-forward";
import {
  ACP_PROVIDER_DEFINITIONS,
  acpProviderCommand,
  isAcpProvider,
  projectedAcpBootstrapFiles,
  refreshAcpAuthSource,
  type AcpProvider,
} from "./acp-config";
import {
  markAcpAccountExhausted,
  listAcpAccounts,
  pickAcpAccount,
  type AcpAccount,
} from "./acp-accounts";
import { providerFor } from "./models";
import { AcpTerminalManager } from "./acp-terminal";
import { filterMcpServers } from "./runner-shared";
import {
  acpProviderStateDir,
  readAcpAccountBinding,
  recordAcpSessionAccountExhausted,
  writeAcpAccountBinding,
} from "./acp-state";

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const MAX_STDERR_BYTES = 8_192;
const MAX_TOOL_RESULT_CHARS = 100_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const source = record(value);
  if (!source) return {};
  return Object.fromEntries(
    Object.entries(source)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => [key, item as string]),
  );
}

/** Convert OpenSession's filtered MCP catalog to ACP's session setup shape. */
export function acpMcpServersForConfig(
  external: Record<string, unknown>,
  proxy: Record<string, unknown> = {},
): McpServer[] {
  const combined = { ...proxy, ...external };
  const out: McpServer[] = [];
  for (const [name, raw] of Object.entries(combined)) {
    const cfg = record(raw);
    if (!cfg) continue;
    if (cfg.type === "http" || cfg.type === "sse" || cfg.url) {
      let url: URL;
      try {
        url = new URL(String(cfg.url || ""));
      } catch {
        console.warn(`[acp] MCP server ${name} has an invalid URL — skipping`);
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        console.warn(`[acp] MCP server ${name} is not HTTP(S) — skipping`);
        continue;
      }
      const type = cfg.type === "sse" ? "sse" : "http";
      out.push({
        type,
        name,
        url: url.toString(),
        headers: Object.entries(stringRecord(cfg.headers)).map(
          ([header, value]) => ({
            name: header,
            value,
          }),
        ),
      });
      continue;
    }
    const requestedCommand =
      typeof cfg.command === "string" ? cfg.command.trim() : "";
    const command = requestedCommand
      ? requestedCommand.startsWith("/")
        ? requestedCommand
        : Bun.which(requestedCommand)
      : null;
    if (!command) {
      console.warn(
        `[acp] MCP server ${name} has no executable command — skipping`,
      );
      continue;
    }
    out.push({
      name,
      command,
      args: Array.isArray(cfg.args)
        ? cfg.args.filter((arg): arg is string => typeof arg === "string")
        : [],
      env: Object.entries(stringRecord(cfg.env)).map(([envName, value]) => ({
        name: envName,
        value,
      })),
    });
  }
  return out;
}

function acpMcpServers(opts: RunAgentOpts): McpServer[] {
  const external = filterMcpServers(
    opts.mcpServers ?? "all",
    opts.user,
    [opts.mcpGrantUser, opts.user],
    {
      allowManagedUserAuth: !!opts.mcpGrantUser,
    },
  );
  // Detached/Docker runner-hosts convert trusted in-process servers into
  // narrow stdio proxies. Direct in-memory SDK servers have no ACP transport
  // representation and are deliberately ignored here.
  const proxy = Object.fromEntries(
    Object.entries(opts.inProcessMcp || {}).filter(([, value]) => {
      const cfg = record(value);
      return !!cfg && typeof cfg.command === "string";
    }),
  );
  return acpMcpServersForConfig(external, proxy);
}

interface AcpControl {
  cancel: () => void;
}

const active = new Map<string, AcpControl>();

export function isAcpSessionBusy(id: string): boolean {
  return active.has(id);
}

export function cancelAcpRun(id: string): boolean {
  const control = active.get(id);
  if (!control) return false;
  control.cancel();
  return true;
}

export function activeAcpRunCount(): number {
  return new Set(active.values()).size;
}

class EventQueue {
  private values: StreamEvent[] = [];
  private waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  private ended = false;

  push(value: StreamEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined as never, done: true });
  }

  async next(): Promise<IteratorResult<StreamEvent>> {
    if (this.values.length) return { value: this.values.shift()!, done: false };
    if (this.ended) return { value: undefined as never, done: true };
    return await new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface PreparedAuth {
  home: string;
  scrub: () => void;
  destroy: () => void;
}

function copyPrivate(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}

function scrubCredentialArtifacts(destination: string): void {
  const directory = dirname(destination);
  const credentialName = basename(destination);
  try {
    for (const entry of readdirSync(directory)) {
      if (entry !== credentialName && !entry.startsWith(`${credentialName}.`))
        continue;
      try {
        rmSync(join(directory, entry), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

function linkProviderSessionState(
  provider: AcpProvider,
  home: string,
  unifiedSessionId: string | undefined,
): void {
  if (!unifiedSessionId) return;
  const providerState = acpProviderStateDir(unifiedSessionId, provider);
  const relative =
    provider === "grok" ? ".grok/sessions" : ".config/cursor/acp-sessions";
  const destination = join(home, relative);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  symlinkSync(providerState, destination, "dir");
}

function prepareAuth(
  provider: AcpProvider,
  unifiedSessionId: string | undefined,
  account?: Pick<AcpAccount, "authPath" | "agentIdPath">,
): PreparedAuth {
  const definition = ACP_PROVIDER_DEFINITIONS[provider];
  const projected = projectedAcpBootstrapFiles();
  const source =
    projected && existsSync(projected.auth)
      ? projected.auth
      : account?.authPath;
  if (!source)
    throw new Error(
      `${provider} subscription authentication is not configured`,
    );
  if (!existsSync(source))
    throw new Error(
      `${provider} subscription authentication is not configured`,
    );

  const home = mkdtempSync(join(tmpdir(), `opensession-${provider}-`));
  chmodSync(home, 0o700);
  linkProviderSessionState(provider, home, unifiedSessionId);
  const authDestination = join(home, definition.authRelativePath);
  copyPrivate(source, authDestination);
  if (projected && source === projected.auth) unlinkSync(source);

  const agentIdDestination = definition.agentIdRelativePath
    ? join(home, definition.agentIdRelativePath)
    : undefined;
  if (agentIdDestination) {
    const agentSource =
      projected && existsSync(projected.agentId)
        ? projected.agentId
        : account?.agentIdPath;
    if (agentSource && existsSync(agentSource)) {
      copyPrivate(agentSource, agentIdDestination);
      if (projected && agentSource === projected.agentId)
        unlinkSync(agentSource);
    }
  }

  const scrub = () => {
    scrubCredentialArtifacts(authDestination);
    if (agentIdDestination) {
      try {
        unlinkSync(agentIdDestination);
      } catch {}
    }
  };
  return {
    home,
    scrub,
    destroy: () => {
      scrub();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    },
  };
}

function cleanError(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(
      /(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{12,}/gi,
      "[redacted]",
    )
    .replace(
      /(?:token|secret|password|authorization)["'=:\s]+[^\s,"'}]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 2_000);
}

function append(
  engineSessionId: string,
  lines: Record<string, unknown>[],
): void {
  if (!lines.length) return;
  const forward = transcriptForwarder();
  if (forward) {
    forward(engineSessionId, lines);
    return;
  }
  void appendTranscriptEntries(engineSessionId, lines).catch((error) =>
    console.error("[acp] transcript append failed:", cleanError(error)),
  );
}

function toolContentText(
  content: ToolCallContent[] | null | undefined,
): string {
  return (content || [])
    .map((item) => {
      const value = item as Record<string, unknown>;
      if (value.type === "content" && value.content) {
        const block = value.content as Record<string, unknown>;
        return block.type === "text" ? String(block.text || "") : "";
      }
      if (value.type === "diff") return String(value.diff || "");
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_TOOL_RESULT_CHARS);
  try {
    return JSON.stringify(value, null, 2).slice(0, MAX_TOOL_RESULT_CHARS);
  } catch {
    return String(value).slice(0, MAX_TOOL_RESULT_CHARS);
  }
}

function selectedPermission(
  request: RequestPermissionRequest,
  allowed: boolean,
): RequestPermissionResponse {
  const preferred = request.options.find((option) =>
    allowed
      ? option.kind === "allow_once" || option.kind === "allow_always"
      : option.kind === "reject_once" || option.kind === "reject_always",
  );
  return preferred
    ? { outcome: { outcome: "selected", optionId: preferred.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

async function permissionResponse(
  opts: RunAgentOpts,
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const tool = request.toolCall.name || request.toolCall.title || "tool";
  if (opts.deniedTools?.[tool]) return selectedPermission(request, false);
  const needsConfirmation = opts.mode === "ask" || !!opts.confirmTools?.[tool];
  if (!needsConfirmation && (opts.mode === "code" || opts.mode === "scratch"))
    return selectedPermission(request, true);
  if (!opts.onAskUser) return selectedPermission(request, false);
  const result = await opts.onAskUser({
    questions: [
      {
        header: "ACP tool",
        question: `Allow ${tool}: ${request.toolCall.title || "requested action"}?`,
        options: [
          { label: "Allow once", description: "Run this tool call once" },
          { label: "Deny", description: "Reject this tool call" },
        ],
        multiSelect: false,
      },
    ],
    tool: request.toolCall,
  });
  return selectedPermission(request, result.behavior === "allow");
}

function sessionModelState(value: unknown): {
  currentModelId?: string;
  availableModels?: Array<{ modelId: string; name: string }>;
  configOptions?: Array<Record<string, unknown>>;
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string }> };
} {
  const response = (value || {}) as Record<string, unknown>;
  return {
    ...((response.models || {}) as object),
    configOptions: response.configOptions as Array<Record<string, unknown>>,
    modes: response.modes as {
      currentModeId?: string;
      availableModes?: Array<{ id: string }>;
    },
  };
}

async function applySelection(
  provider: AcpProvider,
  connection: ClientSideConnection,
  sessionId: string,
  setupResponse: unknown,
  requestedModel: string,
  mode: RunAgentOpts["mode"],
): Promise<void> {
  const state = sessionModelState(setupResponse);
  const requested = requestedModel.slice(requestedModel.indexOf("/") + 1);
  if (provider === "grok") {
    if (state.currentModelId !== requested)
      await connection.extMethod("session/set_model", {
        sessionId,
        modelId: requested,
      });
    return;
  }

  const modelOption = state.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const choices = (modelOption?.options || []) as Array<{
    value?: string;
    name?: string;
  }>;
  const selected = choices.find((choice) =>
    requested === "auto"
      ? choice.name?.toLowerCase() === "auto"
      : choice.name?.toLowerCase() === requested.toLowerCase(),
  );
  if (!selected?.value)
    throw new Error(
      `Cursor subscription does not currently offer ${requested}`,
    );
  if (modelOption?.currentValue !== selected.value)
    await connection.setSessionConfigOption({
      sessionId,
      configId: String(modelOption?.id || "model"),
      value: selected.value,
    });

  const wantedMode = mode === "ask" ? "ask" : "agent";
  if (
    state.modes?.availableModes?.some(
      (candidate) => candidate.id === wantedMode,
    ) &&
    state.modes.currentModeId !== wantedMode
  )
    await connection.setSessionMode({ sessionId, modeId: wantedMode });
}

function isUsageFailure(message: string): boolean {
  return /(?:usage|quota|credits?|subscription).*(?:exhaust|limit|unavailable)|rate.?limit/i.test(
    message,
  );
}

async function* runAcpAttempt(
  opts: RunAgentOpts,
  model: string,
): AsyncGenerator<StreamEvent> {
  const provider = providerFor(model);
  if (!isAcpProvider(provider)) {
    yield { type: "error", content: `Unsupported ACP model: ${model}` };
    return;
  }
  const definition = ACP_PROVIDER_DEFINITIONS[provider];
  const queue = new EventQueue();
  const unifiedSessionId =
    opts.journal?.osSessionId || opts.transcriptSessionId;
  const projected = projectedAcpBootstrapFiles();
  const boundAccountId = unifiedSessionId
    ? readAcpAccountBinding(unifiedSessionId, provider)
    : undefined;
  const account = projected
    ? undefined
    : pickAcpAccount(provider, {
        sessionKey: opts.accountAffinityKey || unifiedSessionId || opts.cwd,
        accountId: opts.accountId || boundAccountId,
        strict: opts.accountStrict,
        user: opts.user,
      });
  if (!projected && !account) {
    yield {
      type: "error",
      content: `${provider}: no usable subscription account is available`,
      provider,
      model,
      usageLimitExhausted: true,
    };
    return;
  }
  if (account) await refreshAcpAuthSource(provider, account.authPath);
  const auth = prepareAuth(provider, unifiedSessionId, account);
  const selectedAccountId =
    account?.id ||
    projected?.accountId ||
    process.env.OPENSESSION_ACP_ACCOUNT_ID ||
    "projected";
  // Provider-native session ids are account-owned. When a spent/removed pin
  // rotates to another subscription, begin a fresh ACP session and let the
  // OpenSession transcript handoff preserve the visible conversation.
  const resumeSessionId =
    boundAccountId && boundAccountId !== selectedAccountId
      ? undefined
      : opts.sessionId;
  const toolHome = mkdtempSync(join(tmpdir(), "opensession-acp-tools-"));
  chmodSync(toolHome, 0o700);
  const terminal = new AcpTerminalManager(opts.cwd, toolHome);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: auth.home,
    XDG_CONFIG_HOME: join(auth.home, ".config"),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    NODE_ENV: process.env.NODE_ENV || "production",
  };
  for (const key of Object.keys(env))
    if (env[key] === undefined) delete env[key];
  const command = acpProviderCommand(provider);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
  } catch (error) {
    // Bun throws synchronously when an executable is absent. Keep that
    // operator/configuration error inside the run stream: escaping this async
    // generator terminates the gateway and makes every other provider and
    // integration unavailable. Authentication was already projected above,
    // so clean it up before returning the ordinary terminal error event.
    auth.destroy();
    try {
      rmSync(toolHome, { recursive: true, force: true });
    } catch {}
    yield {
      type: "error",
      content: `${provider}: ${cleanError(error)}`,
      provider,
      model,
    };
    return;
  }
  let rejectSpawnError!: (error: Error) => void;
  const spawnError = new Promise<never>((_, reject) => {
    rejectSpawnError = reject;
  });
  // Node reports a missing executable asynchronously. Bun currently throws
  // above, but handling both contracts keeps the gateway process-safe across
  // runtimes. Mark the promise handled immediately; the task races it below.
  void spawnError.catch(() => {});
  const onSpawnError = (error: Error) => rejectSpawnError(error);
  child.once("error", onSpawnError);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
  });

  let connection: ClientSideConnection;
  let engineSessionId = resumeSessionId;
  let acceptUpdates = false;
  // Some ACP agents (Grok Build today) omit messageId on streamed chunks. A
  // provider-native session spans many OpenSession turns, so an engine-only
  // fallback would upsert every later reply over the first turn's transcript
  // row. Scope the fallback to this immutable run while keeping all chunks in
  // one turn coalesced onto the same row.
  const turnBlockScope = opts.startToken || crypto.randomUUID();
  const assistantText = new Map<string, string>();
  const thoughtText = new Map<string, string>();
  let finalText = "";
  const aliases = new Set(
    [
      opts.startToken,
      opts.journal?.osSessionId,
      opts.transcriptSessionId,
      resumeSessionId,
    ].filter((id): id is string => !!id),
  );
  const register = (id: string | undefined, control: AcpControl) => {
    if (!id) return;
    aliases.add(id);
    active.set(id, control);
  };
  const persist = (lines: Array<Record<string, unknown> | null>) => {
    if (engineSessionId && unifiedSessionId)
      append(
        engineSessionId,
        lines.filter((line): line is Record<string, unknown> => !!line),
      );
  };

  const handleUpdate = (notification: SessionNotification) => {
    if (!acceptUpdates || notification.sessionId !== engineSessionId) return;
    const update = notification.update as SessionUpdate;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = (update as any).content;
      if (content?.type !== "text" || typeof content.text !== "string") return;
      const id = String(
        (update as any).messageId ||
          `${kind === "agent_thought_chunk" ? "thought" : "message"}-${engineSessionId}-${turnBlockScope}`,
      );
      const target =
        kind === "agent_thought_chunk" ? thoughtText : assistantText;
      const full = (target.get(id) || "") + content.text;
      target.set(id, full);
      if (kind === "agent_message_chunk") {
        finalText += content.text;
        queue.push({ type: "text_chunk", text: content.text, blockId: id });
      }
      persist([
        transcriptLineAssistantText(
          full,
          kind === "agent_thought_chunk" ? `thought-${id}` : id,
          undefined,
          model,
          kind === "agent_thought_chunk",
        ),
      ]);
      return;
    }
    if (kind === "tool_call") {
      const call = update as any;
      const name = String(call.name || call.kind || call.title || "tool");
      queue.push({
        type: "tool_use",
        toolName: name,
        toolInput: call.rawInput ?? {},
        toolUseId: call.toolCallId,
      });
      persist([
        transcriptLineToolUse(call.toolCallId, name, call.rawInput ?? {}),
      ]);
      return;
    }
    if (kind === "tool_call_update") {
      const call = update as any;
      if (call.status !== "completed" && call.status !== "failed") return;
      const content =
        toolContentText(call.content) ||
        stringifyToolResult(call.rawOutput ?? "");
      queue.push({
        type: "tool_result",
        toolUseId: call.toolCallId,
        content,
      });
      persist([
        transcriptLineToolResult(
          call.toolCallId,
          content,
          call.status === "failed",
        ),
      ]);
    }
  };

  const client: Client = {
    requestPermission: (request) => permissionResponse(opts, request),
    sessionUpdate: async (notification) => handleUpdate(notification),
    createTerminal: (params) => terminal.createTerminal(params),
    terminalOutput: (params) => terminal.terminalOutput(params),
    waitForTerminalExit: (params) => terminal.waitForTerminalExit(params),
    killTerminal: (params) => terminal.killTerminal(params),
    releaseTerminal: (params) => terminal.releaseTerminal(params),
  };
  connection = new ClientSideConnection(
    () => client,
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    ),
  );
  let cancelled = false;
  const control: AcpControl = {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      if (engineSessionId)
        void connection.cancel({ sessionId: engineSessionId }).catch(() => {});
    },
  };
  for (const alias of aliases) register(alias, control);

  const task = (async () => {
    try {
      const initialized = await Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { terminal: provider === "grok" },
          clientInfo: { name: "OpenSession", version: "1" },
        }),
        spawnError,
      ]);
      if (initialized.protocolVersion !== PROTOCOL_VERSION)
        throw new Error(
          `${provider} ACP protocol ${initialized.protocolVersion} is incompatible with ${PROTOCOL_VERSION}`,
        );
      if (
        !initialized.authMethods?.some(
          (method) => method.id === definition.authMethod,
        )
      )
        throw new Error(
          `${provider} ACP did not offer subscription authentication`,
        );
      await connection.authenticate({ methodId: definition.authMethod });
      const mcpServers = acpMcpServers(opts);
      const agentCapabilities = initialized.agentCapabilities || {};
      let resumedWithoutState = false;
      const setup = resumeSessionId
        ? agentCapabilities.loadSession
          ? await connection.loadSession({
              sessionId: resumeSessionId,
              cwd: opts.cwd,
              mcpServers,
            })
          : agentCapabilities.sessionCapabilities?.resume != null
            ? ((resumedWithoutState = true),
              await connection.resumeSession({
                sessionId: resumeSessionId,
                cwd: opts.cwd,
                mcpServers,
              }))
            : (() => {
                throw new Error(
                  `${provider} ACP cannot load or resume an existing session`,
                );
              })()
        : await connection.newSession({ cwd: opts.cwd, mcpServers });
      engineSessionId = resumeSessionId || (setup as any)?.sessionId;
      if (unifiedSessionId)
        writeAcpAccountBinding(unifiedSessionId, provider, selectedAccountId);
      if (!engineSessionId)
        throw new Error(`${provider} ACP returned no session id`);
      register(engineSessionId, control);
      if (unifiedSessionId)
        recordEngineSessionOwner(engineSessionId, unifiedSessionId);
      if (!resumedWithoutState || provider === "grok")
        await applySelection(
          provider,
          connection,
          engineSessionId,
          setup,
          model,
          opts.mode,
        );

      // The CLI has authenticated and loaded its provider-native session. From
      // this point on, model-visible tools get neither the credential file nor
      // the one-shot projection used to seed it.
      auth.scrub();
      acceptUpdates = true;
      queue.push({ type: "init", sessionId: engineSessionId, provider, model });

      if (opts.shouldCancel?.()) control.cancel();
      if (cancelled) {
        queue.push({
          type: "error",
          content: `${provider} run cancelled`,
          provider,
          model,
        });
        return;
      }
      const prompt = [
        { type: "text" as const, text: opts.prompt },
        ...(opts.images || []).map((image) => ({
          type: "image" as const,
          mimeType: image.mediaType,
          data: image.data,
        })),
      ];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs =
        Number(process.env.OPENSESSION_ACP_TURN_TIMEOUT_MS) ||
        DEFAULT_TURN_TIMEOUT_MS;
      const response = await Promise.race([
        connection.prompt({ sessionId: engineSessionId, prompt }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            control.cancel();
            reject(
              new Error(`${provider} ACP turn timed out after ${timeoutMs}ms`),
            );
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timeout));
      if (response.stopReason === "cancelled" || cancelled) {
        queue.push({
          type: "error",
          content: `${provider} run cancelled`,
          provider,
          model,
        });
      } else if (response.stopReason === "refusal") {
        queue.push({
          type: "error",
          content: `${provider} refused the request`,
          provider,
          model,
        });
      } else {
        queue.push({
          type: "done",
          sessionId: engineSessionId,
          result: finalText || undefined,
          provider,
          model,
        });
      }
    } catch (error) {
      const message = cleanError(error);
      const detail = cleanError(stderr);
      const content = `${provider}: ${message}${detail && !message.includes(detail) ? ` (${detail})` : ""}`;
      if (engineSessionId)
        persist([
          transcriptLineRunnerNotice(
            content,
            `acp-error-${opts.startToken || crypto.randomUUID()}`,
          ),
        ]);
      queue.push({
        type: "error",
        content,
        provider,
        model,
        usageLimitExhausted: isUsageFailure(content) || undefined,
        noticePersisted: !!engineSessionId,
      });
      if (isUsageFailure(content)) {
        if (!projected && account) markAcpAccountExhausted(account.id);
        if (unifiedSessionId)
          recordAcpSessionAccountExhausted(
            unifiedSessionId,
            provider,
            selectedAccountId,
          );
      }
    } finally {
      acceptUpdates = false;
      child.off("error", onSpawnError);
      await terminal.close();
      try {
        child.kill("SIGTERM");
      } catch {}
      auth.destroy();
      try {
        rmSync(toolHome, { recursive: true, force: true });
      } catch {}
      for (const alias of aliases)
        if (active.get(alias) === control) active.delete(alias);
      queue.end();
    }
  })();

  try {
    for (;;) {
      const next = await queue.next();
      if (next.done) break;
      yield next.value;
    }
    await task;
  } finally {
    if (!cancelled) control.cancel();
    await task.catch(() => {});
  }
}

/**
 * Rotate through subscription accounts when a provider refuses a turn for a
 * usage limit before producing any model-visible work. A detached run receives
 * one credential-minimal projection, so it records the exhausted account and
 * rotates on the next run; in-process runs can retry immediately from the pool.
 */
export async function* runAcp(
  opts: RunAgentOpts,
  model: string,
): AsyncGenerator<StreamEvent> {
  const provider = providerFor(model);
  if (
    !isAcpProvider(provider) ||
    projectedAcpBootstrapFiles() ||
    opts.accountStrict
  ) {
    yield* runAcpAttempt(opts, model);
    return;
  }

  const maxAttempts = Math.max(1, listAcpAccounts(provider).length);
  let lastFailure: StreamEvent | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prefix: StreamEvent[] = [];
    let visible = false;
    let retry = false;
    for await (const event of runAcpAttempt(opts, model)) {
      if (!visible && event.type === "init") {
        prefix.push(event);
        continue;
      }
      if (
        !visible &&
        event.type === "error" &&
        event.usageLimitExhausted === true
      ) {
        lastFailure = event;
        retry = true;
        break;
      }
      for (const buffered of prefix.splice(0)) yield buffered;
      yield event;
      if (event.type !== "done" && event.type !== "error") visible = true;
    }
    if (!retry) return;
  }
  if (lastFailure) yield lastFailure;
}
