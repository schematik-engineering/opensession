import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  loadWorkspaceSeedFiles,
  materializeHostWorkspaceSeedFiles,
} from "./workspace-seed-files";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function repo(seedFiles: string[]) {
  const root = mkdtempSync(join(tmpdir(), "opensession-seeds-"));
  roots.push(root);
  Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents/environment.json"),
    JSON.stringify({ seedFiles }),
  );
  writeFileSync(join(root, ".gitignore"), `${seedFiles.join("\n")}\n`);
  return root;
}

describe("private workspace seed files", () => {
  test("projects into session worktrees, never shared warm templates", () => {
    const source = readFileSync(
      new URL("./worktree.ts", import.meta.url),
      "utf8",
    );
    const sessionSetup = source.slice(
      source.indexOf("async function seedAndInstallWorktree"),
      source.indexOf("export async function installWorktreeDeps"),
    );
    const sharedSetup = source.slice(
      source.indexOf("export async function installWorktreeDeps"),
      source.indexOf("export async function listWorktrees"),
    );
    expect(sessionSetup).toContain(
      "materializeHostWorkspaceSeedFiles(repo, wtPath)",
    );
    expect(sharedSetup).not.toContain("materializeHostWorkspaceSeedFiles");
  });

  test("copies only declared ignored regular files into a host worktree as 0600", () => {
    const root = repo([".env.local", ".vercel/project.json"]);
    for (const [path, content] of [
      [".env.local", "TOKEN=test-only\n"],
      [".vercel/project.json", '{"projectId":"test"}\n'],
    ] as const) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
      chmodSync(join(root, path), 0o644);
    }
    const workspace = join(root, "worktree");
    mkdirSync(workspace);

    expect(
      materializeHostWorkspaceSeedFiles({ id: "app", repo: root }, workspace),
    ).toBe(2);
    expect(readFileSync(join(workspace, ".env.local"), "utf-8")).toBe(
      "TOKEN=test-only\n",
    );
    expect(statSync(join(workspace, ".env.local")).mode & 0o777).toBe(0o600);
    expect(statSync(join(workspace, ".vercel/project.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  test("fails closed for undeclared filesystem traversal and tracked secrets", () => {
    const traversal = repo(["../outside"]);
    expect(() =>
      loadWorkspaceSeedFiles({ id: "app", repo: traversal }),
    ).toThrow("unsafe path");

    const tracked = repo([".env.local"]);
    writeFileSync(join(tracked, ".gitignore"), "");
    writeFileSync(join(tracked, ".env.local"), "TOKEN=test-only\n");
    expect(() => loadWorkspaceSeedFiles({ id: "app", repo: tracked })).toThrow(
      "must be gitignored",
    );
  });
});
