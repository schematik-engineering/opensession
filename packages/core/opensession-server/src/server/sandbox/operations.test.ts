import { describe, expect, test } from "bun:test";
import { compactSandboxOperations, type SandboxOperation } from "./operations";

function operation(
  index: number,
  status: SandboxOperation["status"],
): SandboxOperation {
  const at = new Date(Date.UTC(2026, 7, 29, 12, 0, index)).toISOString();
  return {
    id: `operation-${index}`,
    kind: "qualification",
    provider: "daytona",
    status,
    stage: status === "succeeded" ? "Complete" : "Checking",
    createdAt: at,
    updatedAt: at,
  };
}

describe("sandbox operation retention", () => {
  test("settles restart-interrupted work and bounds repeated failures", () => {
    const compacted = compactSandboxOperations(
      Array.from({ length: 30 }, (_, index) => operation(index, "running")),
      new Set(),
    );
    expect(compacted).toHaveLength(3);
    expect(compacted.every((item) => item.status === "failed")).toBe(true);
    expect(
      compacted.every((item) => item.failureCode === "SERVER_RESTARTED"),
    ).toBe(true);
  });

  test("keeps the newest successes alongside bounded failures", () => {
    const compacted = compactSandboxOperations([
      ...Array.from({ length: 20 }, (_, index) => operation(index, "failed")),
      ...Array.from({ length: 12 }, (_, index) =>
        operation(index + 30, "succeeded"),
      ),
    ]);
    expect(compacted.filter((item) => item.status === "failed")).toHaveLength(
      10,
    );
    expect(
      compacted.filter((item) => item.status === "succeeded"),
    ).toHaveLength(10);
    expect(compacted.some((item) => item.id === "operation-41")).toBe(true);
  });
});
