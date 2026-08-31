/**
 * Per-user authentication for GitHub's hosted MCP server.
 *
 * Open Session already maintains renewable GitHub App user tokens for trusted
 * interactive work. GitHub's remote MCP endpoint accepts the same bearer
 * token, so starting a second, client-registration OAuth flow is both
 * unnecessary and incorrect: GitHub publishes no dynamic-registration
 * endpoint. Callers must still supply a user. Automation-owned runs deliberately
 * pass no user/grant identity and therefore cannot acquire this credential.
 */
import { githubCredentialForRun } from "./github-auth";

const GITHUB_MCP_HOST = "api.githubcopilot.com";

export interface GithubMcpManagedAuth {
  kind: "github-app";
  state: "ready" | "error";
  detail?: string;
}

export function isGithubMcpServer(serverUrl: string | undefined): boolean {
  if (!serverUrl) return false;
  try {
    const url = new URL(serverUrl);
    return url.protocol === "https:" && url.hostname === GITHUB_MCP_HOST;
  } catch {
    return false;
  }
}

/** A fresh header from the renewable GitHub user-token store. */
export function githubMcpAuthHeader(
  serverUrl: string | undefined,
  user?: string,
): string | undefined {
  if (!user || !isGithubMcpServer(serverUrl)) return undefined;
  const token = githubCredentialForRun(user)?.env.GH_TOKEN;
  return token ? `Bearer ${token}` : undefined;
}

export function githubMcpManagedAuth(
  serverUrl: string | undefined,
  user?: string,
): GithubMcpManagedAuth | undefined {
  if (!isGithubMcpServer(serverUrl)) return undefined;
  if (githubMcpAuthHeader(serverUrl, user))
    return {
      kind: "github-app",
      state: "ready",
      detail: "Authenticated with your connected GitHub account",
    };
  return {
    kind: "github-app",
    state: "error",
    detail: "Connect your GitHub account before using GitHub MCP",
  };
}
