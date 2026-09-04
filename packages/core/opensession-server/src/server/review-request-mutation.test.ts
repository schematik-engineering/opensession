import { expect, test } from "bun:test";
import { persistReviewRequest } from "./review-request-mutation";

test("keeps the review assignment when the pull request mirror fails", async () => {
  const state: { reviewer: string | null } = { reviewer: null };
  let mirrorStarted = false;
  let rejectMirror: (error: Error) => void = () => {};
  const mirror = new Promise<void>((_resolve, reject) => {
    rejectMirror = reject;
  });
  const errors: unknown[] = [];

  await persistReviewRequest({
    sessionId: "session-with-failed-mirror",
    persist: () => {
      state.reviewer = "Samuel";
    },
    mirrorToProvider: () => {
      mirrorStarted = true;
      return mirror;
    },
    onMirrorError: (error) => errors.push(error),
  });

  expect(state.reviewer).toBe("Samuel");
  expect(mirrorStarted).toBe(true);

  rejectMirror(new Error("GitHub timed out"));
  await Bun.sleep(0);

  expect(state.reviewer).toBe("Samuel");
  expect(errors).toHaveLength(1);
});

test("keeps provider mirrors in review-request order", async () => {
  const calls: string[] = [];
  let finishFirst: () => void = () => {};
  const firstMirror = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });

  await persistReviewRequest({
    sessionId: "session-with-two-picks",
    persist: () => {
      calls.push("persist first");
    },
    mirrorToProvider: async () => {
      calls.push("mirror first");
      await firstMirror;
    },
  });
  await persistReviewRequest({
    sessionId: "session-with-two-picks",
    persist: () => {
      calls.push("persist second");
    },
    mirrorToProvider: () => {
      calls.push("mirror second");
    },
  });

  expect(calls).toEqual(["persist first", "mirror first", "persist second"]);

  finishFirst();
  await Bun.sleep(0);

  expect(calls).toEqual([
    "persist first",
    "mirror first",
    "persist second",
    "mirror second",
  ]);
});
