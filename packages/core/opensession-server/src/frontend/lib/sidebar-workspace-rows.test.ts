import { describe, expect, test } from "bun:test";
import type { UnifiedSession, Workspace } from "./types";
import { buildWorkspaceRows } from "./sidebar-workspace-rows";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Jaap",
    title: id,
    lastActivity: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-18T11:00:00.000Z",
    isRunning: false,
    ...overrides,
  };
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    createdBy: "Jaap",
    createdAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

function build(
  overrides: Partial<Parameters<typeof buildWorkspaceRows>[0]> = {},
) {
  return buildWorkspaceRows({
    sessions: [],
    workspaces: [],
    openPrs: [],
    activeSubagentIds: new Set(),
    selectedWorkspaceId: null,
    selectedSessionId: null,
    reads: {},
    canonicalNames: new Map(),
    sort: "updated",
    isClaimed: () => false,
    statusForSession: () => "pending",
    pinnedLaneForSession: () => null,
    prLaneForSessions: () => null,
    mentionForSession: () => undefined,
    ...overrides,
  });
}

describe("buildWorkspaceRows", () => {
  test("groups workspace sessions and keeps tab order by creation time", () => {
    const rows = build({
      sessions: [
        session("second", {
          workspaceId: "workspace-1",
          createdAt: "2026-08-18T12:00:00.000Z",
        }),
        session("first", {
          workspaceId: "workspace-1",
          createdAt: "2026-08-18T11:00:00.000Z",
        }),
      ],
      workspaces: [workspace("workspace-1", { name: "Queue cleanup" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("workspace:workspace-1");
    expect(rows[0]?.name).toBe("Queue cleanup");
    expect(rows[0]?.sessions.map(({ id }) => id)).toEqual(["first", "second"]);
  });

  test("treats a running worker as workspace activity without making a second row", () => {
    const rows = build({
      sessions: [
        session("parent", { workspaceId: "workspace-1" }),
        session("worker", {
          workspaceId: "workspace-1",
          parentSessionId: "parent",
          isRunning: true,
        }),
      ],
      workspaces: [workspace("workspace-1")],
      activeSubagentIds: new Set(["worker"]),
      selectedWorkspaceId: "workspace-1",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.running).toBe(true);
    expect(rows[0]?.status).toBe("inprogress");
  });

  test("includes drafts and excludes non-sidebar session kinds", () => {
    const rows = build({
      sessions: [
        session("desk", { desk: true }),
        session("automation", { automation: "Hourly check" }),
      ],
      workspaces: [
        workspace("draft", {
          draft: {
            text: "Investigate this",
            updatedAt: "2026-08-18T13:00:00.000Z",
          },
        }),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "workspace:draft",
      name: "draft",
      sessions: [],
      lastActivity: "2026-08-18T13:00:00.000Z",
    });
  });
});
