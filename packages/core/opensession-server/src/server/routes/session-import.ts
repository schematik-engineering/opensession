import type { TranscriptEntry } from "../types";
import type { Repo } from "../config";
import { audit } from "../audit";
import { configuredRepos } from "../config";
import { parseCodexLinesAsync, parseJsonlLinesAsync } from "../jsonl-parser";
import { parsePaseoLinesAsync } from "../paseo-timeline-parser";
import { importLegacyTranscript } from "../actor-transcript";
import { updateSessionFile } from "../session-cache";
import { sessionIdForRequest } from "../session-request-id";
import {
  createWorkspace,
  findWorkspaceByBranch,
  getWorkspace,
} from "../workspaces";
import {
  readRequestTextWithinLimit,
  RequestBodyTooLargeError,
} from "../shared/bounded-body";
import type { RouteContext } from "./context";
import { requestUser } from "./context";

export const SESSION_IMPORT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export type SessionImportProvider = "claude-code" | "codex" | "paseo";

type SessionImportRequest = {
  provider: SessionImportProvider;
  sourceSessionId: string;
  transcript: string;
  branch: string;
  repo?: string;
  repository?: string;
  title?: string;
  user?: string;
};

type SessionImportRecord = {
  sessionId: string;
  provider: SessionImportProvider;
  sourceSessionId: string;
  branch: string;
  repoId?: string;
  title: string;
  createdBy: string;
  createdByLogin?: string;
  createdAt: string;
  importedAt: string;
  entryCount: number;
};

type RepoIdentity = Pick<Repo, "id" | "ghRepo" | "csRepo">;

export interface SessionImportDependencies {
  repos(): Record<string, RepoIdentity>;
  persist(record: SessionImportRecord): Promise<{ workspaceId: string }>;
  importTranscript(
    sessionId: string,
    entries: TranscriptEntry[],
    source: string,
    watermark: number,
  ): Promise<{ inserted: number; updated: number }>;
}

const defaultDependencies: SessionImportDependencies = {
  repos: configuredRepos,
  persist: persistImportedSession,
  importTranscript: (sessionId, entries, source, watermark) =>
    importLegacyTranscript(sessionId, entries, source, watermark),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type OptionalStringResult =
  | { ok: true; value?: string }
  | { ok: false; error: string };

function optionalString(
  value: unknown,
  name: string,
  maxLength: number,
): OptionalStringResult {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string")
    return { ok: false, error: `${name} must be a string` };
  const text = value.trim();
  if (text.length > maxLength)
    return {
      ok: false,
      error: `${name} exceeds ${maxLength} characters`,
    };
  if (/\p{Cc}/u.test(text))
    return { ok: false, error: `${name} contains control characters` };
  return text ? { ok: true, value: text } : { ok: true };
}

export function parseSessionImportRequest(
  value: unknown,
): { ok: true; request: SessionImportRequest } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "JSON object required" };

  const provider =
    value.provider === "claude" || value.provider === "claude-code"
      ? "claude-code"
      : value.provider === "codex" || value.provider === "paseo"
        ? value.provider
        : null;
  if (!provider)
    return {
      ok: false,
      error: "provider must be claude-code, codex, or paseo",
    };

  const sourceSessionId = optionalString(
    value.sourceSessionId,
    "sourceSessionId",
    256,
  );
  if (!sourceSessionId.ok) return { ok: false, error: sourceSessionId.error };
  if (
    !sourceSessionId.value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sourceSessionId.value)
  )
    return { ok: false, error: "sourceSessionId is invalid" };

  if (typeof value.transcript !== "string" || !value.transcript.trim())
    return { ok: false, error: "transcript is required" };

  const branch = optionalString(value.branch, "branch", 255);
  const repo = optionalString(value.repo, "repo", 200);
  const repository = optionalString(value.repository, "repository", 1000);
  const title = optionalString(value.title, "title", 240);
  const user = optionalString(value.user, "user", 120);
  if (!branch.ok) return { ok: false, error: branch.error };
  if (!repo.ok) return { ok: false, error: repo.error };
  if (!repository.ok) return { ok: false, error: repository.error };
  if (!title.ok) return { ok: false, error: title.error };
  if (!user.ok) return { ok: false, error: user.error };

  return {
    ok: true,
    request: {
      provider,
      sourceSessionId: sourceSessionId.value,
      transcript: value.transcript,
      branch: branch.value ?? "",
      ...(repo.value ? { repo: repo.value } : {}),
      ...(repository.value ? { repository: repository.value } : {}),
      ...(title.value ? { title: title.value } : {}),
      ...(user.value ? { user: user.value } : {}),
    },
  };
}

/** Turn common git remote forms into an owner/name-style comparison key. */
export function normalizedRepositoryKey(value: string): string {
  let candidate = value.trim();
  const scp = candidate.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  if (scp) candidate = scp[1];
  else {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.pathname;
    } catch {
      // A bare owner/name value is already the useful part.
    }
  }
  const parts = candidate
    .replace(/[?#].*$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase();
}

export function resolveSessionImportRepo(
  request: Pick<SessionImportRequest, "repo" | "repository">,
  repos: Record<string, RepoIdentity>,
): { ok: true; repoId?: string } | { ok: false; error: string } {
  if (request.repo) {
    const direct = repos[request.repo];
    if (direct) return { ok: true, repoId: direct.id };
    const folded = Object.values(repos).find(
      (repo) => repo.id.toLowerCase() === request.repo?.toLowerCase(),
    );
    if (folded) return { ok: true, repoId: folded.id };
    return { ok: false, error: `Unknown repository: ${request.repo}` };
  }
  if (!request.repository) return { ok: true };
  const key = normalizedRepositoryKey(request.repository);
  if (!key) return { ok: true };
  const match = Object.values(repos).find((repo) =>
    [repo.ghRepo, repo.csRepo]
      .filter((candidate): candidate is string => !!candidate)
      .some((candidate) => normalizedRepositoryKey(candidate) === key),
  );
  return match ? { ok: true, repoId: match.id } : { ok: true };
}

async function parseImportedTranscript(
  provider: SessionImportProvider,
  transcript: string,
): Promise<TranscriptEntry[]> {
  const lines = transcript.split("\n").filter((line) => line.trim());
  if (provider === "codex") return parseCodexLinesAsync(lines);
  if (provider === "paseo") return parsePaseoLinesAsync(lines);
  return parseJsonlLinesAsync(lines);
}

function canonicalImportEntries(
  sessionId: string,
  provider: SessionImportProvider,
  entries: TranscriptEntry[],
  fallbackTimestamp: string,
): TranscriptEntry[] {
  return entries.map((entry, index) => {
    const timestampMs = Date.parse(entry.timestamp);
    const validTimestamp = Number.isFinite(timestampMs);
    const timestamp = validTimestamp
      ? new Date(timestampMs).toISOString()
      : fallbackTimestamp;
    const sourceIdentity = provider === "paseo" ? entry.id : String(index);
    const id = new Bun.CryptoHasher("sha256")
      .update(
        `${sessionId}\0${sourceIdentity}\0${entry.type}\0${validTimestamp ? timestamp : "invalid"}\0${entry.toolUseId ?? ""}`,
      )
      .digest("hex")
      .slice(0, 40);
    return { ...entry, id: `import-${id}`, timestamp };
  });
}

function titleForImport(entries: TranscriptEntry[], supplied?: string): string {
  if (supplied) return supplied;
  const firstUser = entries.find(
    (entry) => entry.type === "user" && entry.content.trim(),
  );
  const firstLine = firstUser?.content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine || "Imported session").slice(0, 120);
}

function createdAtForImport(
  entries: TranscriptEntry[],
  fallback: string,
): string {
  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return fallback;
}

async function persistImportedSession(
  record: SessionImportRecord,
): Promise<{ workspaceId: string }> {
  let persistedWorkspaceId = `ws-import-${record.sessionId.slice(4)}`;
  await updateSessionFile(record.sessionId, (current) => {
    const exists = current.id === record.sessionId;
    const branchWorkspace =
      record.repoId && record.branch
        ? findWorkspaceByBranch(record.repoId, record.branch)
        : null;
    const workspaceId =
      (current.workspaceId && getWorkspace(current.workspaceId)?.id) ||
      branchWorkspace?.id ||
      `ws-import-${record.sessionId.slice(4)}`;
    if (!getWorkspace(workspaceId))
      createWorkspace({
        id: workspaceId,
        name: record.title,
        repo: record.repoId,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        ...(record.branch ? { branch: record.branch } : {}),
      });
    persistedWorkspaceId = workspaceId;
    return {
      ...current,
      id: record.sessionId,
      claudeSessionId: exists ? current.claudeSessionId : "",
      branch: record.branch,
      worktreeDir: exists ? current.worktreeDir : "",
      createdBy: exists ? current.createdBy : record.createdBy,
      ...(record.createdByLogin
        ? { createdByLogin: record.createdByLogin }
        : {}),
      createdAt: exists ? current.createdAt : record.createdAt,
      title: record.title,
      mode: exists ? current.mode : "ask",
      workspaceId,
      ...(record.repoId
        ? { repo: record.repoId, repoLess: undefined }
        : { repo: undefined, repoLess: true }),
      importedFrom: {
        provider: record.provider,
        sessionId: record.sourceSessionId,
        importedAt: record.importedAt,
        entryCount: record.entryCount,
      },
      lastActivity: record.importedAt,
    };
  });
  return { workspaceId: persistedWorkspaceId };
}

export async function handleSessionImportRoutes(
  ctx: RouteContext,
  dependencies: SessionImportDependencies = defaultDependencies,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;
  if (path !== "/api/sessions/import" || req.method !== "POST")
    return undefined;

  let rawBody: string;
  try {
    rawBody = await readRequestTextWithinLimit(
      req,
      SESSION_IMPORT_MAX_BODY_BYTES,
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json(
        {
          error: `Request body exceeds ${SESSION_IMPORT_MAX_BODY_BYTES} bytes`,
        },
        { status: 413 },
      );
    return Response.json(
      { error: "Could not read request body" },
      { status: 400 },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseSessionImportRequest(decoded);
  if (!parsed.ok)
    return Response.json({ error: parsed.error }, { status: 400 });

  const repo = resolveSessionImportRepo(parsed.request, dependencies.repos());
  if (!repo.ok) return Response.json({ error: repo.error }, { status: 400 });

  const claimedUser = requestUser(ctx, parsed.request.user);
  const createdBy = claimedUser || "Imported";
  const actorScope = ctx.authUser?.login || "local";
  const sessionId = sessionIdForRequest(
    actorScope,
    `external-session:${parsed.request.provider}:${parsed.request.sourceSessionId}`,
  );

  try {
    const parsedEntries = await parseImportedTranscript(
      parsed.request.provider,
      parsed.request.transcript,
    );
    if (parsedEntries.length === 0)
      return Response.json(
        { error: "Transcript has no supported messages" },
        { status: 400 },
      );
    const importedAt = new Date().toISOString();
    const entries = canonicalImportEntries(
      sessionId,
      parsed.request.provider,
      parsedEntries,
      importedAt,
    );
    const persisted = await dependencies.persist({
      sessionId,
      provider: parsed.request.provider,
      sourceSessionId: parsed.request.sourceSessionId,
      branch: parsed.request.branch,
      repoId: repo.repoId,
      title: titleForImport(entries, parsed.request.title),
      createdBy,
      ...(ctx.authUser?.login ? { createdByLogin: ctx.authUser.login } : {}),
      createdAt: createdAtForImport(entries, importedAt),
      importedAt,
      entryCount: entries.length,
    });
    const result = await dependencies.importTranscript(
      sessionId,
      entries,
      `external:${parsed.request.provider}`,
      Buffer.byteLength(parsed.request.transcript),
    );
    const sessionUrl = new URL(
      `/workspace/${encodeURIComponent(persisted.workspaceId)}/session/${encodeURIComponent(sessionId)}`,
      url.origin,
    ).href;
    audit({
      msg: "external_session_imported",
      session_id: sessionId,
      provider: parsed.request.provider,
      entries: entries.length,
      inserted: result.inserted,
      updated: result.updated,
      repo: repo.repoId,
      branch: parsed.request.branch || undefined,
      actor: ctx.authUser?.login || createdBy,
    });
    return Response.json({
      id: sessionId,
      url: sessionUrl,
      entries: entries.length,
      inserted: result.inserted,
      updated: result.updated,
      workspaceId: persisted.workspaceId,
      ...(repo.repoId ? { repo: repo.repoId } : {}),
      branch: parsed.request.branch || null,
    });
  } catch (error) {
    audit({
      msg: "external_session_import_failed",
      session_id: sessionId,
      provider: parsed.request.provider,
      error: error instanceof Error ? error.message : String(error),
      actor: ctx.authUser?.login || createdBy,
    });
    return Response.json({ error: "Session import failed" }, { status: 500 });
  }
}
