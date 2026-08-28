import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { DOCKER_HOST_ENTRY, DOCKER_RUNNER_ROOT } from "./docker";

const dockerfile = readFileSync(
  fileURLToPath(
    new URL("../../../../../../deploy/sandbox/Dockerfile", import.meta.url),
  ),
  "utf8",
);
const buildScript = readFileSync(
  fileURLToPath(
    new URL("../../../../../../deploy/sandbox/build.sh", import.meta.url),
  ),
  "utf8",
);

describe("Docker runner root", () => {
  test("uses one stable in-container path across immutable host releases", () => {
    expect(DOCKER_RUNNER_ROOT).toBe("/home/ubuntu/.opensession-runner");
    expect(DOCKER_HOST_ENTRY).toBe(
      "/home/ubuntu/.opensession-runner/packages/core/opensession-server/src/runner-host/host.ts",
    );
    expect(dockerfile).toContain(
      "OPENSESSION_RUNNER_ROOT=/home/ubuntu/.opensession-runner",
    );
    expect(dockerfile).toContain(
      "COPY --chown=ubuntu:ubuntu scripts ${OPENSESSION_RUNNER_ROOT}/scripts",
    );
    expect(dockerfile).toContain("/runner-host/host.ts \\");
    expect(dockerfile).toContain(
      "--outfile=/tmp/opensession-runner-host-smoke.js",
    );
    expect(dockerfile).toContain("/home/ubuntu/.opensession \\");
    expect(buildScript).not.toContain('--build-arg "OPENSESSION_RUNNER_ROOT=');
  });
});
