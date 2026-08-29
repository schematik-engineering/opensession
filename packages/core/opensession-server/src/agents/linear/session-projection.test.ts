import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("Linear session projection", () => {
  test("a newly saved assignment is immediately indexed and directly readable", async () => {
    const root = mkdtempSync(join(tmpdir(), "linear-projection-"));
    const sessionUrl = pathToFileURL(join(import.meta.dir, "session.ts")).href;
    const listStoreUrl = pathToFileURL(
      join(import.meta.dir, "../../server/session-list-store.ts"),
    ).href;
    const cacheUrl = pathToFileURL(
      join(import.meta.dir, "../../server/session-cache.ts"),
    ).href;
    const script = `
      const { mkdirSync } = await import("node:fs");
      mkdirSync(process.env.HOME + "/.linear-sessions", { recursive: true });
      const list = await import(${JSON.stringify(listStoreUrl)});
      list.sessionListStore().markCovered("include");
      const { saveSessionInfo, ensureLinearWorktree } = await import(${JSON.stringify(sessionUrl)});
      await saveSessionInfo("check-open-sch274", {
        claudeSessionId: null,
        issueIdentifier: "SCH-274",
        issueTitle: "Check open PRs",
        worktreeDir: "/tmp/opensession-check-open-sch274",
        linearSessionId: "linear-agent-session",
        phase: "awaiting_direction",
        issueId: "issue-274",
        issueUrl: "https://linear.app/example/issue/SCH-274",
        participants: [],
        lastActiveUser: null,
        issueCreator: null
      });
      const indexed = list.indexedSessions("include") || [];
      const { findSession } = await import(${JSON.stringify(cacheUrl)});
      const direct = findSession("linear-check-open-sch274");
      const active = { branch: "check-open-sch274", worktreeDir: "/missing/linear-worktree" };
      let revived = 0;
      const repaired = await ensureLinearWorktree(active.worktreeDir, active, async (branch) => {
        revived++;
        return "/tmp/revived-" + branch;
      });
      console.log(JSON.stringify({
        indexed: indexed.some((row) => row.id === "linear-check-open-sch274"),
        recovery: { repaired, stored: active.worktreeDir, revived },
        direct: direct && {
          id: direct.id,
          source: direct.source,
          worktreeDir: direct.worktreeDir,
          title: direct.title
        }
      }));
      process.exit(0);
    `;

    try {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          HOME: root,
          OPENSESSION_STATE_DIR: root,
          OPENSESSION_SESSIONS_DIR: join(root, "sessions"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const resultLine = stdout.trim().split("\n").at(-1);
      expect(resultLine).toBeTruthy();
      expect(JSON.parse(resultLine!)).toEqual({
        indexed: true,
        recovery: {
          repaired: "/tmp/revived-check-open-sch274",
          stored: "/tmp/revived-check-open-sch274",
          revived: 1,
        },
        direct: {
          id: "linear-check-open-sch274",
          source: "linear",
          worktreeDir: "/tmp/opensession-check-open-sch274",
          title: "SCH-274: Check open PRs",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
