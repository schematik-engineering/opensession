import type { RunHostSpec } from "../../runner-host/protocol";
import { githubServiceCredentialEnv } from "../github-app";
import { githubAuthEnv } from "../github-auth";
import { isGithubServiceCredentialRun } from "../run-policy";
import { writeJsonAtomic } from "../shared/atomic-write";

export type SandboxGithubCredentialMode = "none" | "interactive" | "service";

/** Choose authority before resolving a token. Unattended runs never receive a
 * person's credential; approved publication paths use the repository-scoped
 * GitHub App instead. */
export function sandboxGithubCredentialMode(
  spec: Pick<RunHostSpec, "journalKind" | "mode" | "trustProfile">,
): SandboxGithubCredentialMode {
  if (isGithubServiceCredentialRun(spec.mode, spec.journalKind)) {
    return "service";
  }
  return spec.trustProfile === "automation" ? "none" : "interactive";
}

/** Resolve the ephemeral GitHub capability for one sandbox run. The repository
 * name must come from server-owned sandbox state, never the guest's origin. */
export async function sandboxGithubAuth(
  spec: Pick<
    RunHostSpec,
    "author" | "journalKind" | "mode" | "trustProfile" | "user"
  >,
  githubRepo?: string,
): Promise<Record<string, string>> {
  const mode = sandboxGithubCredentialMode(spec);
  if (mode === "none") return {};
  if (mode === "interactive") {
    return githubAuthEnv(spec.user || spec.author?.name);
  }
  return githubRepo ? githubServiceCredentialEnv(githubRepo) : {};
}

/** Write this run's selected authority beside its private host spec. An empty
 * file is deliberate: it tells the runner to ignore ambient gh configuration.
 * runner-host removes the file on every exit path. */
export function writeSandboxGithubAuth(
  runDir: string,
  auth: Readonly<Record<string, string>>,
): string {
  const path = `${runDir}/github-auth.json`;
  const token = auth.GH_TOKEN || auth.GITHUB_TOKEN;
  writeJsonAtomic(
    path,
    token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {},
    false,
    0o600,
  );
  return path;
}
