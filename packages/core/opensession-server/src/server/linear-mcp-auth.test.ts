import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const previousHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "os-linear-mcp-auth-"));
process.env.HOME = home;
writeFileSync(
  join(home, ".linear-agent-tokens.json"),
  JSON.stringify({
    organization: {
      accessToken: "linear-app-token",
      expiresAt: Date.now() + 60 * 60_000,
    },
  }),
);

const { withDynamicCredentials } = await import("./connections");

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Linear MCP managed auth", () => {
  test("overlays the app token without changing the configured server name", () => {
    const result = withDynamicCredentials({
      Linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Accept: "application/json" },
      },
    });

    expect(result).toMatchObject({
      Linear: {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer linear-app-token",
        },
      },
    });
    expect(result).not.toHaveProperty("linear");
  });
});
