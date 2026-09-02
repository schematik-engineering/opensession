import { describe, expect, test } from "bun:test";
import type { Repo } from "./config";
import { buildScanPrompt } from "./security";

const repo: Repo = {
  id: "biss-client",
  label: "Biss client",
  repo: "/tmp/biss-client",
  wtPrefix: "biss-client",
  defaultBranch: "main",
  ghRepo: "schematik-engineering/biss-client",
};

describe("security scan publication", () => {
  test("keeps headless GitHub scans report-only", () => {
    const prompt = buildScanPrompt(repo);

    expect(prompt).toContain(
      "Do not commit, push, open pull requests, or call the GitHub API.",
    );
    expect(prompt).toContain("exact file and line references");
    expect(prompt).not.toContain("gh pr create");
    expect(prompt).not.toContain("git push -u origin deepsec-scan-");
  });

  test("leaves interactive GitHub publication available after confirmation", () => {
    const prompt = buildScanPrompt(repo, null, undefined, "pull-request");

    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("One PR per finding");
  });
});
