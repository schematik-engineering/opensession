import { describe, expect, test } from "bun:test";

const worktreeSource = await Bun.file(
  new URL("./worktree.ts", import.meta.url),
).text();
const warmTemplateSource = await Bun.file(
  new URL("./warm-template.ts", import.meta.url),
).text();

function directFetches(source: string): string[] {
  return [
    ...source.matchAll(/await \$`git -C [^`]+ fetch origin[^`]*`[\s\S]*?;/g),
  ].map((match) => match[0]);
}

describe("GitHub worktree fetch authentication", () => {
  test("routes every direct GitHub fetch through the App credential broker", () => {
    const worktreeFetches = directFetches(worktreeSource);
    const warmTemplateFetches = directFetches(warmTemplateSource);
    expect(worktreeFetches.length).toBeGreaterThan(0);
    expect(warmTemplateFetches.length).toBeGreaterThan(0);
    for (const statement of [...worktreeFetches, ...warmTemplateFetches]) {
      expect(statement).toContain(".env(");
    }
    expect(worktreeSource).toContain(
      "export async function githubServiceGitEnv(",
    );
    expect(
      worktreeSource.match(/await githubServiceGitEnv\(repo\.ghRepo\)/g),
    ).toHaveLength(7);
  });

  test("uses the broker when no user-scoped credential was supplied", () => {
    expect(worktreeSource.match(/const shell = \$\.env\(/g)).toHaveLength(2);
    expect(
      worktreeSource.match(/: await githubServiceGitEnv\(repo\.ghRepo\)/g),
    ).toHaveLength(2);
    expect(warmTemplateSource).toContain(
      "const gitEnv = await githubServiceGitEnv(repo.ghRepo)",
    );
  });
});
