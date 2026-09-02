import { describe, expect, test } from "bun:test";
import { isGithubServiceCredentialRun } from "./run-policy";

describe("GitHub service credential run policy", () => {
  test("allows only approved unattended code publication paths", () => {
    expect(isGithubServiceCredentialRun("code", "github-review")).toBe(true);
    expect(isGithubServiceCredentialRun("code", "security-scan")).toBe(true);
    expect(isGithubServiceCredentialRun("code", "security-scan-resume")).toBe(
      true,
    );

    expect(isGithubServiceCredentialRun("ask", "security-scan")).toBe(false);
    expect(isGithubServiceCredentialRun("code", "automation")).toBe(false);
    expect(isGithubServiceCredentialRun("code", "prompt")).toBe(false);
  });
});
