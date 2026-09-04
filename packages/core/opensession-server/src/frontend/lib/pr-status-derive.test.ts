import { describe, expect, test } from "bun:test";
import { deriveStatus, isDeployment } from "./pr-status-derive";
import type { PrCheck, PrDetails } from "./types";

const check = (name: string, workflowName?: string): PrCheck => ({
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  workflowName,
});

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

describe("deriveStatus", () => {
  test("treats requested reviewers as an outstanding review", () => {
    const expected = {
      key: "review",
      label: "Open",
      qualifier: "Review required",
      tone: "yellow",
    } satisfies ReturnType<typeof deriveStatus>;
    expect(
      deriveStatus(
        pullRequest({
          reviewers: [{ login: "sam", state: "PENDING" }],
        }),
      ),
    ).toEqual(expected);
    expect(
      deriveStatus(pullRequest({ reviewDecision: "REVIEW_REQUIRED" })),
    ).toEqual(expected);
  });

  test("keeps ready PRs green when nobody was asked to review", () => {
    expect(deriveStatus(pullRequest())).toEqual({
      key: "ready",
      label: "Open",
      qualifier: "Ready to merge",
      tone: "green",
    });
  });
});

describe("isDeployment", () => {
  test("matches Vercel's own status contexts", () => {
    // The git integration posts one per project, with no check run behind it.
    expect(isDeployment(check("Vercel – internal"))).toBe(true);
    expect(isDeployment(check("Vercel – tella-emails"))).toBe(true);
    expect(isDeployment(check("Preview – tella"))).toBe(true);
    expect(isDeployment(check("vercel/tella"))).toBe(true);
  });

  test("matches a preview deploy that runs as an Actions job", () => {
    // tella-fusion's webapp preview. Its workflow is literally named "Preview",
    // so a "no workflow ⇒ deployment" rule reads it as CI and leaves the
    // staging globe green through the whole rebuild.
    expect(
      isDeployment(check("Deploy Vercel App / Build and deploy", "Preview")),
    ).toBe(true);
    expect(isDeployment(check("Deploy Preview Lambda", "Preview"))).toBe(true);
  });

  test("does not match checks that merely mention Vercel or preview", () => {
    // GitHub Apps post these with an empty workflowName, so they used to pass
    // the "no workflow" gate and count as deploys.
    expect(isDeployment(check("Vercel Agent Review", ""))).toBe(false);
    expect(isDeployment(check("Vercel Preview Comments", ""))).toBe(false);
    expect(isDeployment(check("Check Vercel Log Drain", "Preview"))).toBe(
      false,
    );
    expect(
      isDeployment(check("Check preview-lambda label / check", "Preview")),
    ).toBe(false);
  });

  test("does not match ordinary CI", () => {
    expect(isDeployment(check("Webapp tests (Bun)", "Validate"))).toBe(false);
    expect(isDeployment(check("Check formatting", "Validate"))).toBe(false);
    expect(isDeployment(check("code/snyk (tella)"))).toBe(false);
    expect(
      isDeployment(check("Terraform Cloud/Tella/tella-fusion-stage")),
    ).toBe(false);
  });
});
