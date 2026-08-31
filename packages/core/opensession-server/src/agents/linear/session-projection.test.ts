import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        newSessionRepo: "biss-client",
        repos: {
          opensession: {
            repo: join(root, "opensession"),
            default: true,
          },
          "biss-client": { repo: join(root, "biss-client") },
        },
      }),
    );
    const script = `
      const { mkdirSync } = await import("node:fs");
      mkdirSync(process.env.HOME + "/.linear-sessions", { recursive: true });
      const list = await import(${JSON.stringify(listStoreUrl)});
      list.sessionListStore().markCovered("include");
      const { saveSessionInfo, loadSessionInfo, ensureLinearWorktree, linearSessionRepoId } = await import(${JSON.stringify(sessionUrl)});
      const repoId = linearSessionRepoId();
      await saveSessionInfo("check-open-sch274", {
        repoId,
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
      await Bun.write(process.env.HOME + "/.linear-sessions/legacy.json", JSON.stringify({
        branch: "legacy",
        worktreeDir: process.env.OPENSESSION_STATE_DIR + "/.opensession/worktrees/biss-client-legacy"
      }));
      const legacyRepoId = (await loadSessionInfo("legacy"))?.repoId;
      const active = { branch: "check-open-sch274", repoId, worktreeDir: "/missing/linear-worktree" };
      let revived = 0;
      let revivedRepo = "";
      const repaired = await ensureLinearWorktree(active.worktreeDir, active, async (branch, selectedRepo) => {
        revived++;
        revivedRepo = selectedRepo || "";
        return "/tmp/revived-" + branch;
      });
      console.log(JSON.stringify({
        repoId,
        legacyRepoId,
        indexed: indexed.some((row) => row.id === "linear-check-open-sch274"),
        recovery: { repaired, stored: active.worktreeDir, revived, revivedRepo },
        direct: direct && {
          id: direct.id,
          source: direct.source,
          repo: direct.repo,
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
          OPENSESSION_CONFIG: configPath,
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
        repoId: "biss-client",
        legacyRepoId: "biss-client",
        indexed: true,
        recovery: {
          repaired: "/tmp/revived-check-open-sch274",
          stored: "/tmp/revived-check-open-sch274",
          revived: 1,
          revivedRepo: "biss-client",
        },
        direct: {
          id: "linear-check-open-sch274",
          source: "linear",
          repo: "biss-client",
          worktreeDir: "/tmp/opensession-check-open-sch274",
          title: "SCH-274: Check open PRs",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
