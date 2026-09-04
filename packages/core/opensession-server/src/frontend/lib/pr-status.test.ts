import { describe, expect, test } from "bun:test";
import { prStatusDisplay } from "./pr-status";

describe("prStatusDisplay", () => {
  test("uses the same conflict status for references and hover cards", () => {
    expect(
      prStatusDisplay({ state: "OPEN", mergeable: "CONFLICTING" }),
    ).toEqual({ label: "Conflicts", state: "conflicts", tone: "red" });
  });

  test("marks required reviews as pending", () => {
    expect(
      prStatusDisplay({ state: "OPEN", reviewDecision: "REVIEW_REQUIRED" }),
    ).toEqual({
      label: "Review required",
      state: "review-required",
      tone: "yellow",
    });
  });

  test("keeps terminal lifecycle states authoritative", () => {
    expect(prStatusDisplay({ state: "MERGED" })).toEqual({
      label: "Merged",
      state: "merged",
      tone: "purple",
    });
    expect(prStatusDisplay({ state: "CLOSED" })).toEqual({
      label: "Closed",
      state: "closed",
      tone: "muted",
    });
  });
});
