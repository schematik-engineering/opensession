import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("Docker ACP credential projection", () => {
  test("refreshes the host credential before copying the private run projection", () => {
    const source = readFileSync(
      new URL("./docker.ts", import.meta.url),
      "utf8",
    );
    const refresh = source.indexOf("await refreshAcpAuthSource(acpProvider)");
    const projection = source.indexOf(
      "copyFileSync(authSource, authDestination)",
    );
    expect(refresh).toBeGreaterThan(0);
    expect(projection).toBeGreaterThan(refresh);
    expect(source).not.toContain("refresh_token=");
  });
});
