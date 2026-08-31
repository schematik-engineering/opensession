import type { AutomationOutput } from "./api/automations";

function uniqueOutputId(prefix: string, outputs: AutomationOutput[]): string {
  const used = new Set(outputs.map((output) => output.id));
  let candidate = prefix;
  let index = 2;
  while (used.has(candidate)) candidate = `${prefix}-${index++}`;
  return candidate;
}

export function automationOutputSummary(output: AutomationOutput): string {
  if (output.type === "report")
    return `Reports · ${output.publish || "always"}`;
  const service = output.type === "slack" ? "Slack" : "Discord";
  const delivery =
    output.enabled === false
      ? "disabled"
      : `${output.minUrgency || "high"}/${output.minConfidence || "high"}`;
  return `${service} ${output.channel} · ${delivery}`;
}

export function appendReportOutput(
  outputs: AutomationOutput[],
): AutomationOutput[] {
  if (outputs.some((output) => output.type === "report")) return outputs;
  return [
    ...outputs,
    {
      id: uniqueOutputId("report", outputs),
      type: "report",
      enabled: true,
      publish: "always",
    },
  ];
}

export function appendMessageOutput(
  outputs: AutomationOutput[],
  type: "slack" | "discord",
  channel = "",
): AutomationOutput[] {
  const withReport = appendReportOutput(outputs);
  return [
    ...withReport,
    {
      id: uniqueOutputId(type, withReport),
      type,
      enabled: true,
      channel,
      minUrgency: "high",
      minConfidence: "high",
    },
  ];
}
