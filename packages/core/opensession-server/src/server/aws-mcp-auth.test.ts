import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetAwsMcpIamAuthForTest,
  awsMcpIamAuthHeader,
  awsMcpManagedAuth,
  awsMcpTarget,
  awsMcpTokenCommand,
  ensureAwsMcpIamAuth,
  isAwsMcpIamServer,
  type AwsMcpTokenSpawn,
} from "./aws-mcp-auth";
import { withDynamicCredentials } from "./connections";

const URL = "https://aws-mcp.eu-central-1.api.aws/mcp";

describe("AWS MCP IAM authentication", () => {
  beforeEach(__resetAwsMcpIamAuthForTest);
  afterEach(__resetAwsMcpIamAuthForTest);

  test("recognizes only official HTTPS AWS MCP endpoints", () => {
    expect(awsMcpTarget(URL)).toEqual({
      region: "eu-central-1",
      resource: "aws-mcp.amazonaws.com",
    });
    expect(isAwsMcpIamServer("https://aws-mcp.us-gov-west-1.api.aws/mcp")).toBe(
      true,
    );
    expect(isAwsMcpIamServer("http://aws-mcp.eu-central-1.api.aws/mcp")).toBe(
      false,
    );
    expect(isAwsMcpIamServer("https://aws-mcp.example.com/mcp")).toBe(false);
  });

  test("invokes only the fixed root-owned exchange helper", () => {
    expect(awsMcpTokenCommand("eu-central-1")).toEqual([
      "sudo",
      "-n",
      "/usr/local/libexec/opensession-aws-mcp-token",
      "eu-central-1",
    ]);
  });

  test("caches a valid bearer token and shares concurrent exchanges", async () => {
    const calls: string[][] = [];
    const spawn: AwsMcpTokenSpawn = async (argv) => {
      calls.push(argv);
      await Promise.resolve();
      return {
        code: 0,
        stdout: JSON.stringify({
          accessToken: "header.payload.signature",
          tokenType: "Bearer",
          expiresIn: 3600,
        }),
        stderr: "",
      };
    };

    const [first, second] = await Promise.all([
      ensureAwsMcpIamAuth(URL, spawn),
      ensureAwsMcpIamAuth(URL, spawn),
    ]);
    expect(first).toBe("Bearer header.payload.signature");
    expect(second).toBe(first);
    expect(calls).toEqual([awsMcpTokenCommand("eu-central-1")]);
    expect(awsMcpIamAuthHeader(URL)).toBe(first);
    expect(awsMcpManagedAuth(URL)).toEqual({
      kind: "aws-iam",
      state: "ready",
    });
    expect(
      (
        withDynamicCredentials(
          {
            AWS: {
              type: "http",
              url: URL,
              headers: { Authorization: "Bearer stale-static-token" },
            },
          },
          "Someone with an OAuth grant",
        ).AWS as { headers: { Authorization: string } }
      ).headers.Authorization,
    ).toBe(first);
  });

  test("fails closed on malformed output without exposing it as a header", async () => {
    const spawn: AwsMcpTokenSpawn = async () => ({
      code: 0,
      stdout: JSON.stringify({
        accessToken: "too-short",
        tokenType: "Basic",
        expiresIn: 7200,
      }),
      stderr: "",
    });

    await expect(ensureAwsMcpIamAuth(URL, spawn)).rejects.toThrow(
      "invalid token response",
    );
    expect(awsMcpIamAuthHeader(URL)).toBeUndefined();
    expect(awsMcpManagedAuth(URL)).toMatchObject({
      kind: "aws-iam",
      state: "error",
    });
  });

  test("reports helper failures but never copies stdout tokens into errors", async () => {
    const spawn: AwsMcpTokenSpawn = async () => ({
      code: 1,
      stdout: '{"accessToken":"must-not-leak"}',
      stderr: "AccessDeniedException: role cannot mint this token",
    });

    await expect(ensureAwsMcpIamAuth(URL, spawn)).rejects.toThrow(
      "AccessDeniedException",
    );
    expect(awsMcpManagedAuth(URL)?.detail).not.toContain("must-not-leak");
  });
});
