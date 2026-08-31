import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("Docker ACP credential projection", () => {
  test("projects one private account before dispatching the detached host", () => {
    const source = readFileSync(
      new URL("./docker.ts", import.meta.url),
      "utf8",
    );
    const projection = source.indexOf(
      "await projectAcpRunCredentials(spec, dir)",
    );
    const dispatch = source.indexOf("const r = await docker(args)");
    expect(projection).toBeGreaterThan(0);
    expect(dispatch).toBeGreaterThan(projection);
    expect(source).toContain("OPENSESSION_ACP_ACCOUNT_ID=");
    expect(source).not.toContain("refresh_token=");
  });
});
