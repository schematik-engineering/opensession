import { describe, expect, test } from "bun:test";
import { DOCKER_ENABLE_CONFIG } from "./sandbox";

describe("Docker sandbox enablement", () => {
  test("uses the local Unix-socket transport by default", () => {
    expect(DOCKER_ENABLE_CONFIG).toMatchObject({
      workspace: "volume",
      transport: "socket",
    });
    expect(DOCKER_ENABLE_CONFIG).not.toHaveProperty("callbackBaseUrl");
  });
});
