import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "../types";
import type { RouteContext } from "./context";
import {
  handleSessionImportRoutes,
  normalizedRepositoryKey,
  parseSessionImportRequest,
  resolveSessionImportRepo,
  SESSION_IMPORT_MAX_BODY_BYTES,
  type SessionImportDependencies,
} from "./session-import";

const timestamp = "2026-08-20T10:00:00.000Z";

function claudeTranscript(): string {
  return [
    JSON.stringify({
      type: "user",
      uuid: "user-1",
      timestamp,
      message: { role: "user", content: "Import this conversation" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-08-20T10:00:01.000Z",
      message: { role: "assistant", content: "I will upload it." },
    }),
  ].join("\n");
}

function codexTranscript(): string {
  return [
    JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: { type: "user_message", message: "Open this Codex thread" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T10:00:01.000Z",
      payload: { type: "agent_message", message: "Ready." },
    }),
  ].join("\n");
}

function context(
  body: unknown,
  authUser: RouteContext["authUser"] = { login: "ada", name: "Ada Lovelace" },
  headers?: HeadersInit,
): RouteContext {
  const url = new URL("https://sessions.example.test/api/sessions/import");
  return {
    req: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    url,
    path: "/api/sessions/import",
    publicPrefix: "",
    authUser,
  };
}

type Persisted = Parameters<SessionImportDependencies["persist"]>[0];

function harness() {
  const persisted: Persisted[] = [];
  const imports: Array<{ sessionId: string; entries: TranscriptEntry[] }> = [];
  const dependencies: SessionImportDependencies = {
    repos: () => ({
      opensession: {
        id: "opensession",
        ghRepo: "tellahq/opensession",
      },
    }),
    persist: async (record) => {
      persisted.push(record);
      return { workspaceId: "ws-imported" };
    },
    importTranscript: async (sessionId, entries) => {
      imports.push({ sessionId, entries });
      return { inserted: entries.length, updated: 0 };
    },
  };
  return { dependencies, imports, persisted };
}

describe("session import request parsing", () => {
  test("normalizes the Claude provider alias", () => {
    const parsed = parseSessionImportRequest({
      provider: "claude",
      sourceSessionId: "session-1",
      transcript: claudeTranscript(),
      branch: "feature/import",
    });
    expect(parsed).toMatchObject({
      ok: true,
      request: { provider: "claude-code", branch: "feature/import" },
    });
  });

  test("rejects control characters in branch metadata", () => {
    expect(
      parseSessionImportRequest({
        provider: "codex",
        sourceSessionId: "session-1",
        transcript: codexTranscript(),
        branch: "feature/import\nforged",
      }),
    ).toEqual({ ok: false, error: "branch contains control characters" });
  });
});

describe("session import repository matching", () => {
  const repos = {
    opensession: { id: "opensession", ghRepo: "tellahq/opensession" },
  };

  test("matches HTTPS and SSH GitHub remotes", () => {
    expect(
      normalizedRepositoryKey("git@github.com:tellahq/opensession.git"),
    ).toBe("tellahq/opensession");
    expect(
      resolveSessionImportRepo(
        { repository: "https://github.com/tellahq/opensession.git" },
        repos,
      ),
    ).toEqual({ ok: true, repoId: "opensession" });
  });

  test("fails an explicit unknown repo but tolerates an unmatched remote", () => {
    expect(resolveSessionImportRepo({ repo: "missing" }, repos)).toEqual({
      ok: false,
      error: "Unknown repository: missing",
    });
    expect(
      resolveSessionImportRepo(
        { repository: "https://github.com/elsewhere/project.git" },
        repos,
      ),
    ).toEqual({ ok: true });
  });
});

describe("POST /api/sessions/import", () => {
  test("imports a Claude transcript, branch, and matched repository", async () => {
    const h = harness();
    const response = await handleSessionImportRoutes(
      context({
        provider: "claude-code",
        sourceSessionId: "0d5ff956-8d21-4dd6-9894-bf21a414099b",
        transcript: claudeTranscript(),
        branch: "feature/session-import",
        repository: "git@github.com:tellahq/opensession.git",
      }),
      h.dependencies,
    );

    expect(response?.status).toBe(200);
    const result = await response?.json();
    expect(result).toMatchObject({
      entries: 2,
      inserted: 2,
      repo: "opensession",
      branch: "feature/session-import",
    });
    expect(result.url).toBe(
      `https://sessions.example.test/workspace/ws-imported/session/${result.id}`,
    );
    expect(result.workspaceId).toBe("ws-imported");
    expect(h.persisted[0]).toMatchObject({
      sessionId: result.id,
      provider: "claude-code",
      title: "Import this conversation",
      createdBy: "Ada",
      createdByLogin: "ada",
      repoId: "opensession",
    });
    expect(h.imports[0]?.entries.map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("gives repeat uploads stable session and entry ids", async () => {
    const h = harness();
    const body = {
      provider: "codex",
      sourceSessionId: "0198c4d9-5613-7ad0-bca0-abca7bcb9f6b",
      transcript: codexTranscript(),
      branch: "codex/import",
    };
    const first = await handleSessionImportRoutes(
      context(body),
      h.dependencies,
    );
    const second = await handleSessionImportRoutes(
      context(body),
      h.dependencies,
    );
    const firstBody = await first?.json();
    const secondBody = await second?.json();

    expect(secondBody.id).toBe(firstBody.id);
    expect(h.imports).toHaveLength(2);
    expect(h.imports[1]?.entries.map((entry) => entry.id)).toEqual(
      h.imports[0]?.entries.map((entry) => entry.id),
    );
  });

  test("rejects an oversized declared request before reading it", async () => {
    const h = harness();
    const response = await handleSessionImportRoutes(
      context({ provider: "codex" }, null, {
        "content-length": String(SESSION_IMPORT_MAX_BODY_BYTES + 1),
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(413);
    expect(h.persisted).toHaveLength(0);
  });

  test("does not create a session for an unsupported transcript", async () => {
    const h = harness();
    const response = await handleSessionImportRoutes(
      context({
        provider: "claude-code",
        sourceSessionId: "empty-1",
        transcript: JSON.stringify({ type: "progress", data: "not a message" }),
        branch: "",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "Transcript has no supported messages",
    });
    expect(h.persisted).toHaveLength(0);
  });
});
