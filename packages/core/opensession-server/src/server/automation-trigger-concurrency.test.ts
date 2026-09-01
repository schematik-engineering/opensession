import { describe, expect, test } from "bun:test";
import { automationTriggerAllowsConcurrency } from "./automations";

describe("automation trigger concurrency", () => {
  test("accepts every webhook and event while serializing manual and cron runs", () => {
    expect(automationTriggerAllowsConcurrency("webhook")).toBe(true);
    expect(automationTriggerAllowsConcurrency("event")).toBe(true);
    expect(automationTriggerAllowsConcurrency("manual")).toBe(false);
    expect(automationTriggerAllowsConcurrency("cron")).toBe(false);
  });
});
