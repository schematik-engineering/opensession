import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  sandboxGithubAuth,
  sandboxGithubCredentialMode,
  writeSandboxGithubAuth,
} from "./github-projection";

describe("sandbox GitHub credential projection", () => {
  test("keeps personal credentials interactive and service credentials scoped", () => {
    expect(
      sandboxGithubCredentialMode({
        mode: "code",
        journalKind: "prompt",
        trustProfile: "interactive",
      }),
    ).toBe("interactive");
    expect(
      sandboxGithubCredentialMode({
        mode: "code",
        journalKind: "automation",
        trustProfile: "automation",
      }),
    ).toBe("none");
    expect(
      sandboxGithubCredentialMode({
        mode: "code",
        journalKind: "security-scan",
        trustProfile: "automation",
      }),
    ).toBe("none");
  });

  test("does not replace missing personal auth with service auth", async () => {
    expect(
      await sandboxGithubAuth(
        {
          mode: "code",
          journalKind: "prompt",
          trustProfile: "interactive",
          user: "missing-github-user",
        },
        "schematik-engineering/opensession",
      ),
    ).toEqual({});
  });

  test("local Docker projects the private file before host dispatch", () => {
    const source = readFileSync(
      new URL("./docker.ts", import.meta.url),
      "utf8",
    );
    const resolveAuth = source.indexOf("await sandboxGithubAuth(");
    const writeAuth = source.indexOf("writeSandboxGithubAuth(dir, githubAuth)");
    const passAuth = source.indexOf(
      "env(`${GITHUB_RUN_AUTH_FILE_ENV}=${projectedGithubPath}`)",
    );
    const dispatch = source.indexOf("const r = await docker(args)");

    expect(resolveAuth).toBeGreaterThan(0);
    expect(writeAuth).toBeGreaterThan(resolveAuth);
    expect(source).toContain(
      "...env(`${GITHUB_RUN_AUTH_FILE_ENV}=${projectedGithubPath}`)",
    );
    expect(passAuth).toBeGreaterThan(writeAuth);
    expect(dispatch).toBeGreaterThan(passAuth);
  });

  test("writes a private run-scoped file even without authority", () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-projection-"));
    try {
      const path = writeSandboxGithubAuth(dir, {
        GH_TOKEN: "run-token",
      });
      expect(path).toBe(`${dir}/github-auth.json`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        GH_TOKEN: "run-token",
        GITHUB_TOKEN: "run-token",
      });

      expect(writeSandboxGithubAuth(dir, {})).toBe(path);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
