import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { githubMcpAuthHeader, githubMcpManagedAuth } from "./github-mcp-auth";
import { withDynamicCredentials } from "./connections";

const saved = {
  config: process.env.OPENSESSION_CONFIG,
  auth: process.env.OPENSESSION_GITHUB_AUTH_STORE,
};
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "os-github-mcp-test-"));
  const config = join(dir, "config.json");
  const auth = join(dir, "github-auth.json");
  writeFileSync(
    config,
    JSON.stringify({
      integrations: { github: { userPrAuth: true, oauthClientId: "client" } },
      identity: { team: [{ name: "Jack", github: "jackdnl" }] },
    }),
  );
  writeFileSync(
    auth,
    JSON.stringify({
      users: {
        jackdnl: {
          login: "jackdnl",
          token: "github-user-token",
          source: "device",
          expiresAt: "2999-01-01T00:00:00.000Z",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  process.env.OPENSESSION_GITHUB_AUTH_STORE = auth;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.config === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = saved.config;
  if (saved.auth === undefined)
    delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
  else process.env.OPENSESSION_GITHUB_AUTH_STORE = saved.auth;
});

describe("GitHub MCP managed auth", () => {
  test("reuses the mapped interactive user's renewable GitHub App token", () => {
    expect(
      githubMcpAuthHeader("https://api.githubcopilot.com/mcp/", "Jack"),
    ).toBe("Bearer github-user-token");
    expect(
      githubMcpManagedAuth("https://api.githubcopilot.com/mcp/", "jackdnl"),
    ).toMatchObject({ kind: "github-app", state: "ready" });
    expect(
      withDynamicCredentials(
        {
          Github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
          },
        },
        ["Jack"],
      ),
    ).toMatchObject({
      Github: { headers: { Authorization: "Bearer github-user-token" } },
    });
  });

  test("fails closed without an interactive user or on another host", () => {
    expect(
      githubMcpAuthHeader("https://api.githubcopilot.com/mcp/"),
    ).toBeUndefined();
    expect(
      githubMcpAuthHeader("https://example.com/mcp", "Jack"),
    ).toBeUndefined();
    expect(
      githubMcpManagedAuth("https://api.githubcopilot.com/mcp/"),
    ).toMatchObject({ kind: "github-app", state: "error" });
    expect(
      withDynamicCredentials({
        Github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
        },
      }),
    ).not.toHaveProperty("Github.headers.Authorization");
  });
});
