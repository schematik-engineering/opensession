import { describe, expect, test } from "bun:test";
import type { AutomationOutput } from "./api/automations";
import {
  appendMessageOutput,
  appendReportOutput,
  automationOutputSummary,
} from "./automation-output-editor";

describe("automation output editor", () => {
  test("adds one durable report output", () => {
    const report = {
      id: "report",
      type: "report",
      enabled: true,
      publish: "always",
    } satisfies AutomationOutput;

    expect(appendReportOutput([])).toEqual([report]);
    expect(appendReportOutput([report])).toEqual([report]);
  });

  test("sets up Discord delivery with a report and fetched channel", () => {
    const outputs = appendMessageOutput([], "discord", "1542925450790305912");

    expect(outputs).toEqual([
      {
        id: "report",
        type: "report",
        enabled: true,
        publish: "always",
      },
      {
        id: "discord",
        type: "discord",
        enabled: true,
        channel: "1542925450790305912",
        minUrgency: "high",
        minConfidence: "high",
      },
    ]);
  });

  test("labels Discord delivery in automation details", () => {
    expect(
      automationOutputSummary({
        id: "discord",
        type: "discord",
        channel: "1542925450790305912",
        minUrgency: "high",
        minConfidence: "medium",
      }),
    ).toBe("Discord 1542925450790305912 · high/medium");
  });

  test("keeps an existing report and creates unique message ids", () => {
    const outputs: AutomationOutput[] = [
      { id: "report", type: "report", publish: "on_findings" },
      { id: "slack", type: "slack", channel: "C0123456789" },
    ];

    expect(appendMessageOutput(outputs, "slack").at(-1)?.id).toBe("slack-2");
    expect(appendMessageOutput(outputs, "discord")).toHaveLength(3);
  });
});
