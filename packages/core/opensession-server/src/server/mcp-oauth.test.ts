import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setMcpOauthStorePathForTest,
  authorizationServerMetadataUrls,
  completeMcpOauthFlow,
  discoverMcpOauth,
  mcpOauthStartBlocker,
  protectedResourceMetadataUrls,
  resolveMcpOauthClient,
  startMcpOauthFlow,
  supportsManualToken,
  validateManualMcpToken,
} from "./mcp-oauth";

describe("MCP OAuth client registration", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    __setMcpOauthStorePathForTest();
  });

  test("builds path-scoped RFC 9728 and RFC 8414 metadata URLs", () => {
    expect(
      protectedResourceMetadataUrls("https://api.githubcopilot.com/mcp/"),
    ).toEqual([
      "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/",
      "https://api.githubcopilot.com/.well-known/oauth-protected-resource",
    ]);
    expect(
      authorizationServerMetadataUrls("https://github.com/login/oauth")[0],
    ).toBe(
      "https://github.com/.well-known/oauth-authorization-server/login/oauth",
    );
  });

  test("discovers GitHub from its path-scoped resource and issuer metadata", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (
        url ===
        "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"
      )
        return Response.json({
          resource: "https://api.githubcopilot.com/mcp/",
          authorization_servers: ["https://github.com/login/oauth"],
          scopes_supported: ["repo"],
        });
      if (
        url ===
        "https://github.com/.well-known/oauth-authorization-server/login/oauth"
      )
        return Response.json({
          authorization_endpoint: "https://github.com/login/oauth/authorize",
          token_endpoint: "https://github.com/login/oauth/access_token",
        });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const discovered = await discoverMcpOauth(
      "https://api.githubcopilot.com/mcp/",
    );
    expect(discovered).toMatchObject({
      resource: "https://api.githubcopilot.com/mcp/",
      scopes: ["repo"],
      endpoints: {
        authorize: "https://github.com/login/oauth/authorize",
        token: "https://github.com/login/oauth/access_token",
      },
    });
    expect(requested[0]).toEndWith(
      "/.well-known/oauth-protected-resource/mcp/",
    );
    expect(requested[1]).toEndWith(
      "/.well-known/oauth-authorization-server/login/oauth",
    );
  });

  test("starts Google Drive with a configured static OAuth client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-mcp-oauth-test-"));
    __setMcpOauthStorePathForTest(join(dir, "oauth.json"));
    let tokenRequest: Request | undefined;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (
        url ===
        "https://drivemcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1"
      )
        return Response.json({
          resource: "https://drivemcp.googleapis.com/mcp/v1",
          authorization_servers: ["https://accounts.google.com"],
          scopes_supported: ["https://www.googleapis.com/auth/drive"],
        });
      if (
        url ===
        "https://accounts.google.com/.well-known/oauth-authorization-server"
      )
        return Response.json({
          authorization_endpoint:
            "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
        });
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequest = new Request(input, init);
        return Response.json({
          access_token: "google-access-token",
          refresh_token: "google-refresh-token",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const result = await startMcpOauthFlow(
        "GoogleDrive",
        "https://drivemcp.googleapis.com/mcp/v1",
        undefined,
        { clientId: "google-client", clientSecret: "google-secret" },
      );
      const url = new URL(result.url);
      expect(url.origin + url.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      expect(url.searchParams.get("client_id")).toBe("google-client");
      expect(url.searchParams.get("resource")).toBe(
        "https://drivemcp.googleapis.com/mcp/v1",
      );
      expect(url.searchParams.get("scope")).toBe(
        "https://www.googleapis.com/auth/drive",
      );
      await completeMcpOauthFlow(url.searchParams.get("state")!, "auth-code");
      expect(tokenRequest).toBeDefined();
      const tokenBody = new URLSearchParams(await tokenRequest!.text());
      expect(tokenBody.get("client_id")).toBe("google-client");
      expect(tokenBody.get("client_secret")).toBe("google-secret");
      expect(tokenBody.get("code_verifier")).toBeTruthy();
      expect(tokenBody.get("resource")).toBe(
        "https://drivemcp.googleapis.com/mcp/v1",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explains Figma's catalog restriction instead of reporting invalid JSON", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.figma.com/mcp",
          authorization_servers: ["https://api.figma.com"],
          scopes_supported: ["mcp:connect"],
        });
      }
      if (
        url === "https://api.figma.com/.well-known/oauth-authorization-server"
      ) {
        return Response.json({
          authorization_endpoint: "https://www.figma.com/oauth/mcp",
          token_endpoint: "https://api.figma.com/v1/oauth/token",
          registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
        });
      }
      if (url === "https://api.figma.com/v1/oauth/mcp/register") {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      startMcpOauthFlow("Figma test", "https://mcp.figma.com/mcp"),
    ).rejects.toThrow(
      "Its remote MCP server accepts only clients listed in the Figma MCP Catalog",
    );
  });

  test("classifies providers that cannot use dynamic client registration", () => {
    expect(mcpOauthStartBlocker("Fal")).toContain("API keys");
    expect(mcpOauthStartBlocker("x")).toContain("pre-registered OAuth client");
    expect(mcpOauthStartBlocker("renamed", "https://mcp.fal.ai/mcp")).toContain(
      "API keys",
    );
    expect(mcpOauthStartBlocker("Cloudflare")).toBeUndefined();
    expect(
      mcpOauthStartBlocker(
        "GoogleDrive",
        "https://drivemcp.googleapis.com/mcp/v1",
      ),
    ).toContain("authorized redirect URI");
    expect(
      mcpOauthStartBlocker(
        "GoogleDrive",
        "https://drivemcp.googleapis.com/mcp/v1",
        { clientId: "configured", clientSecret: "configured-secret" },
      ),
    ).toBeUndefined();
    expect(
      mcpOauthStartBlocker("Github", "https://api.githubcopilot.com/mcp/"),
    ).toContain("connected GitHub account");
    expect(resolveMcpOauthClient({ clientId: " configured " })).toEqual({
      clientId: "configured",
    });
  });
});

describe("manual MCP token providers", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("recognizes Vero as a token-connected provider", () => {
    expect(supportsManualToken("vero")).toBe(true);
  });

  test("recognizes Fal case-insensitively as a token-connected provider", () => {
    expect(supportsManualToken("Fal")).toBe(true);
    expect(supportsManualToken("renamed", "https://mcp.fal.ai/mcp")).toBe(true);
  });

  test("validates a Fal key against the hosted MCP initialize endpoint", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      request = new Request(input, init);
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    }) as typeof fetch;

    await validateManualMcpToken("Fal", "test-fal-key");

    expect(request?.url).toBe("https://mcp.fal.ai/mcp");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer test-fal-key");
    expect(await request?.json()).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
  });

  test("validates a Vero key against the MCP initialize endpoint", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      request = new Request(input, init);
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    }) as typeof fetch;

    await validateManualMcpToken("vero", "test-vero-key");

    expect(request?.url).toBe("https://api.getvero.com/mcp");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer test-vero-key");
    expect(await request?.json()).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
  });

  test("explains when Vero rejects a key", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 401 })) as unknown as typeof fetch;

    await expect(validateManualMcpToken("vero", "bad-key")).rejects.toThrow(
      "Vero rejected that key",
    );
  });
});
