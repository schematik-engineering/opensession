/**
 * Private files explicitly projected from a registered checkout into a fresh
 * session workspace. The manifest is repository-owned, but it is always read
 * from the operator-controlled checkout/default ref so an agent branch cannot
 * request arbitrary host files.
 */

import { chmodSync, existsSync, lstatSync, readFileSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import { writeFileAtomic } from "./shared/atomic-write";

const SEED_MANIFEST = ".agents/environment.json";
const MAX_SEED_FILE_BYTES = 1024 * 1024;
const MAX_SEED_TOTAL_BYTES = 4 * 1024 * 1024;

export interface WorkspaceSeedFile {
  path: string;
  content: string;
}

export function loadWorkspaceSeedFiles(repo: {
  id: string;
  repo: string;
  defaultBranch?: string;
}): WorkspaceSeedFile[] {
  let manifestText: string | null = null;
  if (repo.defaultBranch) {
    const ref = `refs/remotes/origin/${repo.defaultBranch}`;
    const refExists = Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        repo.repo,
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (refExists.exitCode === 0) {
      const shown = Bun.spawnSync({
        cmd: ["git", "-C", repo.repo, "show", `${ref}:${SEED_MANIFEST}`],
        stdout: "pipe",
        stderr: "ignore",
      });
      if (shown.exitCode !== 0) return [];
      manifestText = shown.stdout.toString("utf-8");
    }
  }
  if (manifestText == null) {
    const manifestPath = resolve(repo.repo, SEED_MANIFEST);
    if (!existsSync(manifestPath)) return [];
    manifestText = readFileSync(manifestPath, "utf-8");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(
      `${repo.id} ${SEED_MANIFEST} is invalid JSON: ${(error as Error).message}`,
    );
  }
  const seedFiles = (raw as { seedFiles?: unknown })?.seedFiles;
  if (
    !Array.isArray(seedFiles) ||
    !seedFiles.every((file) => typeof file === "string")
  ) {
    throw new Error(
      `${repo.id} ${SEED_MANIFEST} must contain a string[] seedFiles`,
    );
  }

  const seen = new Set<string>();
  const loaded: WorkspaceSeedFile[] = [];
  let total = 0;
  for (const path of seedFiles) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(
        `${repo.id} ${SEED_MANIFEST} has unsafe path ${JSON.stringify(path)}`,
      );
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const source = resolve(repo.repo, path);
    const within = relative(repo.repo, source);
    if (!within || within.startsWith("..") || isAbsolute(within)) {
      throw new Error(`${repo.id} seed file escapes the checkout: ${path}`);
    }
    if (!existsSync(source)) {
      throw new Error(
        `${repo.id} requires local seed file ${path}; create it in ${repo.repo} before preparing a workspace`,
      );
    }
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `${repo.id} seed file must be a regular file, not a symlink: ${path}`,
      );
    }
    const ignored = Bun.spawnSync({
      cmd: ["git", "-C", repo.repo, "check-ignore", "-q", "--", path],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (ignored.exitCode !== 0) {
      throw new Error(
        `${repo.id} seed file must be gitignored before projection: ${path}`,
      );
    }
    if (stat.size > MAX_SEED_FILE_BYTES) {
      throw new Error(`${repo.id} seed file exceeds 1 MiB: ${path}`);
    }
    total += stat.size;
    if (total > MAX_SEED_TOTAL_BYTES) {
      throw new Error(`${repo.id} seed files exceed the 4 MiB workspace limit`);
    }
    const content = readFileSync(source, "utf-8");
    if (content.includes("\0")) {
      throw new Error(`${repo.id} seed file must be text: ${path}`);
    }
    loaded.push({ path, content });
  }
  return loaded;
}

/** Materialize declared files into a host worktree before `.agents/setup`. */
export function materializeHostWorkspaceSeedFiles(
  repo: { id: string; repo: string; defaultBranch?: string },
  workspace: string,
): number {
  const files = loadWorkspaceSeedFiles(repo);
  for (const file of files) {
    const target = resolve(workspace, file.path);
    const within = relative(workspace, target);
    if (!within || within.startsWith("..") || isAbsolute(within)) {
      throw new Error(`${repo.id} seed target escapes the workspace`);
    }
    writeFileAtomic(target, file.content, 0o600);
    chmodSync(target, 0o600);
  }
  return files.length;
}

export const workspaceSeedManifest = SEED_MANIFEST;
