import { describe, expect, test } from "bun:test";
import { stoppedSandboxIsDisposable } from "./docker";

describe("stopped Docker sandbox retention", () => {
  const safe = {
    busy: false,
    idleForMs: 31 * 60_000,
    idleThresholdMs: 30 * 60_000,
    snapshotsEnabled: true,
    hasSnapshot: true,
  };

  test("removes only idle containers with a durable snapshot", () => {
    expect(stoppedSandboxIsDisposable(safe)).toBe(true);
    expect(stoppedSandboxIsDisposable({ ...safe, busy: true })).toBe(false);
    expect(stoppedSandboxIsDisposable({ ...safe, hasSnapshot: false })).toBe(
      false,
    );
    expect(
      stoppedSandboxIsDisposable({ ...safe, snapshotsEnabled: false }),
    ).toBe(false);
    expect(
      stoppedSandboxIsDisposable({ ...safe, idleForMs: 29 * 60_000 }),
    ).toBe(false);
  });
});
