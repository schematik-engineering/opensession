import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { refreshGrokAuthFile } from "./acp-config";

const tempDirs: string[] = [];
const NOW = Date.parse("2026-08-29T08:00:00.000Z");

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function authFile(expiresAt: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opensession-grok-auth-"));
  tempDirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      "https://auth.x.ai::client-id": {
        key: "old-access-token",
        auth_mode: "oidc",
        refresh_token: "old-refresh-token",
        expires_at: expiresAt,
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "client-id",
        email: "operator@example.test",
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

function readAuth(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Grok OIDC refresh", () => {
  test("keeps a current credential without making a network request", async () => {
    const path = authFile("2026-08-29T10:00:00.000Z");
    let calls = 0;
    const refreshed = await refreshGrokAuthFile(path, {
      nowMs: NOW,
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    expect(refreshed).toBe(false);
    expect(calls).toBe(0);
    expect(readAuth(path)["https://auth.x.ai::client-id"].key).toBe(
      "old-access-token",
    );
  });

  test("refreshes an expired credential atomically and preserves mode 0600", async () => {
    const path = authFile("2026-08-29T07:00:00.000Z");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          token_endpoint: "https://auth.x.ai/oauth2/token",
        });
      }
      return Response.json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 21_600,
      });
    }) as unknown as typeof fetch;

    expect(
      await refreshGrokAuthFile(path, { nowMs: NOW, fetchImpl: fakeFetch }),
    ).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.x.ai/.well-known/openid-configuration",
      "https://auth.x.ai/oauth2/token",
    ]);
    expect(requests[1].init?.method).toBe("POST");
    expect(String(requests[1].init?.body)).toBe(
      "grant_type=refresh_token&refresh_token=old-refresh-token&client_id=client-id",
    );
    const updated = readAuth(path)["https://auth.x.ai::client-id"];
    expect(updated).toMatchObject({
      key: "rotated-access-token",
      refresh_token: "rotated-refresh-token",
      expires_at: "2026-08-29T14:00:00.000Z",
      email: "operator@example.test",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("fails safely on a revoked grant without exposing the response body", async () => {
    const path = authFile("2026-08-29T07:00:00.000Z");
    const before = readFileSync(path, "utf8");
    const responseSecret = "provider-body-secret";
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          token_endpoint: "https://auth.x.ai/oauth2/token",
        });
      }
      return Response.json(
        { error: "invalid_grant", error_description: responseSecret },
        { status: 400 },
      );
    }) as unknown as typeof fetch;

    let message = "";
    try {
      await refreshGrokAuthFile(path, { nowMs: NOW, fetchImpl: fakeFetch });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("refresh failed (400 invalid_grant)");
    expect(message).toContain("run grok login again");
    expect(message).not.toContain(responseSecret);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("rejects permissive credential files before reading or refreshing", async () => {
    const path = authFile("2026-08-29T07:00:00.000Z");
    chmodSync(path, 0o644);
    expect(refreshGrokAuthFile(path, { nowMs: NOW })).rejects.toThrow(
      "private regular file",
    );
  });
});
