import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrDetails } from "../../lib/types";
import { GitStatusRows } from "./GitStatus";

function pullRequest(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    number: 42,
    title: "Pull request",
    url: "https://github.com/tellahq/app/pull/42",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "",
    author: "octocat",
    body: "",
    checks: [],
    mergeable: "MERGEABLE",
    ...overrides,
  };
}

function render(pr: PrDetails): string {
  return renderToStaticMarkup(
    <GitStatusRows
      git={null}
      pr={pr}
      sessionId="session-1"
      onRefresh={() => undefined}
      onMerge={() => undefined}
    />,
  );
}

describe("GitStatusRows merge action", () => {
  test("uses an amber action while reviews are outstanding", () => {
    const html = render(
      pullRequest({
        reviewers: [{ login: "sam", state: "PENDING" }],
      }),
    );

    expect(html).toContain("Review required");
    expect(html).toContain(">Merge</button>");
    expect(html).toContain("text-yellow");
  });

  test("uses a green action when the PR is ready", () => {
    const html = render(pullRequest());

    expect(html).toContain("Ready to merge");
    expect(html).toContain(">Merge</button>");
    expect(html).toContain("text-green");
  });

  test("does not offer Merge for failed checks", () => {
    const html = render(
      pullRequest({
        checks: [{ name: "Test", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    );

    expect(html).toContain("Checks failed");
    expect(html).not.toContain(">Merge</button>");
  });
});
