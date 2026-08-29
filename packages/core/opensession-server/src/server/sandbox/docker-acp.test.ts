import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("Docker ACP credential projection", () => {
  test("selects and refreshes one account before copying the private run projection", () => {
    const source = readFileSync(
      new URL("./docker.ts", import.meta.url),
      "utf8",
    );
    const selection = source.indexOf("pickAcpAccount(acpProvider");
    const refresh = source.indexOf("await refreshAcpAuthSource(");
    const projection = source.indexOf(
      "copyFileSync(authSource, authDestination)",
    );
    expect(selection).toBeGreaterThan(0);
    expect(refresh).toBeGreaterThan(selection);
    expect(projection).toBeGreaterThan(refresh);
    expect(source).toContain("acpSessionExhaustedAccounts(");
    expect(source).toContain("OPENSESSION_ACP_ACCOUNT_ID=");
    expect(source).not.toContain("refresh_token=");
  });
});
