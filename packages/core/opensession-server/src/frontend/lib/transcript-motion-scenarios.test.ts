import { describe, expect, test } from "bun:test";
import {
  applyTranscriptMotionEvent,
  makeTranscriptMotionScenario,
  makeTranscriptStreamPerformanceScenario,
  transcriptMotionFixtureOptions,
} from "./transcript-motion-scenarios";

describe("transcript motion scenarios", () => {
  test("are deterministic and finish settled", () => {
    const first = makeTranscriptMotionScenario(42);
    const second = makeTranscriptMotionScenario(42);
    expect(first).toEqual(second);
    expect(first.events.length).toBeGreaterThan(15);
    expect(first.events.at(-1)).toMatchObject({
      kind: "set-busy",
      busy: false,
    });
  });

  test("fuzzes valid transcript state across many seeds", () => {
    for (let seed = 1; seed <= 250; seed++) {
      const scenario = makeTranscriptMotionScenario(seed);
      let state = scenario.initial;
      let previousAt = -1;
      for (const event of scenario.events) {
        expect(event.atMs).toBeGreaterThanOrEqual(previousAt);
        previousAt = event.atMs;
        state = applyTranscriptMotionEvent(state, event);
        const ids = [
          ...state.entries.map((entry) => entry.id),
          ...state.optimisticEntries.map((entry) => entry.id),
        ];
        expect(new Set(ids).size).toBe(ids.length);
      }
      expect(state.busy).toBe(false);
      expect(state.optimisticEntries).toHaveLength(0);
      expect(state.entries.at(-1)?.type).toBe("assistant");
    }
  });

  test("lands the exact streamed answer so no live duplicate survives", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const scenario = makeTranscriptMotionScenario(seed);
      const streamed = scenario.events
        .filter((event) => event.kind === "stream-append")
        .map((event) => event.text)
        .join("");
      const landed = scenario.events.find(
        (event) => event.kind === "stream-land",
      );
      expect(landed?.kind === "stream-land" ? landed.content : null).toBe(
        streamed,
      );
    }
  });

  test("builds the 10k-entry 100-delta stream workload", () => {
    const scenario = makeTranscriptStreamPerformanceScenario();
    expect(scenario.initial.entries).toHaveLength(10_000);
    expect(
      scenario.events.filter((event) => event.kind === "stream-append"),
    ).toHaveLength(100);
    expect(scenario.events.at(-1)?.kind).toBe("stream-finish");
  });

  test("updates growing entries without reordering their row", () => {
    const scenario = makeTranscriptMotionScenario(7);
    let state = scenario.initial;
    const append = scenario.events.find(
      (event) =>
        event.kind === "append-entry" && event.entry.type === "tool_result",
    );
    if (!append || append.kind !== "append-entry")
      throw new Error("missing tool result");
    state = applyTranscriptMotionEvent(state, append);
    const index = state.entries.findIndex(
      (entry) => entry.id === append.entry.id,
    );
    const update = scenario.events.find(
      (event) => event.kind === "update-entry" && event.id === append.entry.id,
    );
    if (!update || update.kind !== "update-entry")
      throw new Error("missing update");
    state = applyTranscriptMotionEvent(state, update);
    expect(state.entries[index]?.id).toBe(append.entry.id);
    expect(state.entries[index]?.content).toBe(update.content);
  });

  test("recognizes only the isolated fixture route", () => {
    expect(
      transcriptMotionFixtureOptions(
        "/opensession/__fixtures/transcript-motion",
        "?seed=9&speed=100",
      ),
    ).toEqual({ seed: 9, speed: 20, profile: "motion" });
    expect(
      transcriptMotionFixtureOptions(
        "/__fixtures/transcript-motion",
        "?profile=stream",
      ),
    ).toEqual({ seed: 1, speed: 1, profile: "stream" });
    expect(transcriptMotionFixtureOptions("/session/example", "")).toBeNull();
  });
});
