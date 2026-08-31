/**
 * Generic automation outputs. Reports are the durable source artifact; other
 * sinks consume their structured metadata after a successful run. This keeps
 * external delivery server-controlled and means the primary model never needs
 * a Slack or Discord write tool.
 */

import { readFileSync, rmSync } from "fs";
import { configuredServer } from "./config";
import { stateDir } from "./paths";
import {
  listReportsForSession,
  type ReportConfidence,
  type ReportMeta,
  type ReportUrgency,
} from "./reports";
import { writeJsonAtomic } from "./shared/atomic-write";

interface AutomationOutputBase {
  id: string;
  type: "report" | "slack" | "discord";
  enabled?: boolean;
}

export interface ReportAutomationOutput extends AutomationOutputBase {
  type: "report";
  publish?: "always" | "on_findings";
}

interface MessageAutomationOutput extends AutomationOutputBase {
  channel: string;
  source?: "report";
  minUrgency?: ReportUrgency;
  minConfidence?: ReportConfidence;
}

export interface SlackAutomationOutput extends MessageAutomationOutput {
  type: "slack";
}

export interface DiscordAutomationOutput extends MessageAutomationOutput {
  type: "discord";
}

export type AutomationOutput =
  | ReportAutomationOutput
  | SlackAutomationOutput
  | DiscordAutomationOutput;

const OUTPUT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const SLACK_CONVERSATION_RE = /^[CDG][A-Z0-9]{6,}$/;
const DISCORD_CHANNEL_RE = /^\d{15,22}$/;
const URGENCY_SCORE: Record<ReportUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
const CONFIDENCE_SCORE: Record<ReportConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};
const OUTPUT_STATE_ROOT = stateDir("automation-output-state");

interface OutputState {
  delivered: Record<string, { reportId: string; at: string }>;
}

function outputStateFile(automationId: string): string {
  return `${OUTPUT_STATE_ROOT}/${automationId}.json`;
}

function readOutputState(automationId: string): OutputState {
  try {
    const parsed = JSON.parse(
      readFileSync(outputStateFile(automationId), "utf8"),
    );
    return parsed && typeof parsed.delivered === "object"
      ? { delivered: parsed.delivered }
      : { delivered: {} };
  } catch {
    return { delivered: {} };
  }
}

export function deleteAutomationOutputState(automationId: string): void {
  rmSync(outputStateFile(automationId), { force: true });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isReportUrgency(value: unknown): value is ReportUrgency {
  return typeof value === "string" && value in URGENCY_SCORE;
}

function isReportConfidence(value: unknown): value is ReportConfidence {
  return typeof value === "string" && value in CONFIDENCE_SCORE;
}

export function sanitizeAutomationOutputs(
  value: unknown,
): AutomationOutput[] | undefined | { error: string } {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return { error: "outputs must be an array" };
  if (value.length > 8) return { error: "outputs supports at most 8 sinks" };
  const ids = new Set<string>();
  const outputs: AutomationOutput[] = [];
  for (let index = 0; index < value.length; index++) {
    const candidate: unknown = value[index];
    const at = `outputs[${index}]`;
    if (!isObjectRecord(candidate)) return { error: `${at} must be an object` };
    const raw = candidate;
    const id = String(raw.id || "")
      .trim()
      .toLowerCase();
    if (!OUTPUT_ID_RE.test(id))
      return { error: `${at}.id must be a short slug` };
    if (ids.has(id)) return { error: `duplicate automation output id "${id}"` };
    ids.add(id);
    const enabled = raw.enabled !== false;
    if (raw.type === "report") {
      const publish = raw.publish || "always";
      if (publish !== "always" && publish !== "on_findings")
        return { error: `${at}.publish is invalid` };
      outputs.push({ id, type: "report", enabled, publish });
      continue;
    }
    if (raw.type === "slack" || raw.type === "discord") {
      const type = raw.type;
      const channel = String(raw.channel || "").trim();
      if (
        type === "slack" &&
        !SLACK_CONVERSATION_RE.test(channel.toUpperCase())
      )
        return {
          error: `${at}.channel must be a Slack C…/D…/G… conversation id`,
        };
      if (type === "discord" && !DISCORD_CHANNEL_RE.test(channel))
        return {
          error: `${at}.channel must be a Discord channel id`,
        };
      const minUrgency = raw.minUrgency || "high";
      const minConfidence = raw.minConfidence || "high";
      if (!isReportUrgency(minUrgency))
        return { error: `${at}.minUrgency is invalid` };
      if (!isReportConfidence(minConfidence))
        return { error: `${at}.minConfidence is invalid` };
      outputs.push({
        id,
        type,
        enabled,
        channel: type === "slack" ? channel.toUpperCase() : channel,
        source: "report",
        minUrgency,
        minConfidence,
      });
      continue;
    }
    return { error: `${at}.type is unsupported` };
  }
  return outputs.length ? outputs : undefined;
}

/** Prompt contract for model-authored report delivery. Disabled sinks stay hidden. */
export function automationOutputInstructions(
  outputs?: AutomationOutput[],
): string {
  const report = outputs?.find(
    (output): output is ReportAutomationOutput =>
      output.type === "report" && output.enabled !== false,
  );
  const hasMessageSink = outputs?.some(
    (output) => output.type !== "report" && output.enabled !== false,
  );
  const publish = report?.publish || (hasMessageSink ? "always" : null);
  if (!publish) return "";
  return [
    "## Required output",
    publish === "always"
      ? "Publish exactly one final report with `opensession-report.publish_report` on every successful run."
      : "Publish one final report with `opensession-report.publish_report` when there are material findings or a meaningful change; otherwise call `finish_silently` and explain why no report is warranted.",
    "For analytical findings, pass structured `highlights`. Give every highlight an urgency (time-to-action) and confidence (certainty in the assessment), plus sourceRefs when evidence exists. Also set the report-level urgency and confidence. Do not confuse urgency with confidence.",
  ].join("\n\n");
}

function reportMeetsThreshold(
  report: ReportMeta,
  output: MessageAutomationOutput,
): boolean {
  if (!report.urgency || !report.confidence) return false;
  return (
    URGENCY_SCORE[report.urgency] >=
      URGENCY_SCORE[output.minUrgency || "high"] &&
    CONFIDENCE_SCORE[report.confidence] >=
      CONFIDENCE_SCORE[output.minConfidence || "high"]
  );
}

/** Neutralize Slack mrkdwn mention syntax in fallback text. */
function neutralText(value: string, max: number): string {
  return value.replace(/</g, "‹").replace(/>/g, "›").trim().slice(0, max);
}

export function automationSlackBlocks(
  report: ReportMeta,
  reportUrl: string,
): any[] {
  const title = neutralText(report.title, 150);
  const summary = neutralText(
    report.summary || "Open the report for details.",
    1200,
  );
  const signal = `${report.urgency} urgency · ${report.confidence} confidence`;
  const actions: any[] = [];
  if (report.tasks?.length) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Fix these" },
      style: "primary",
      action_id: "report-fix-all",
      value: JSON.stringify({
        automationId: report.automationId,
        reportId: report.id,
      }),
    });
  }
  actions.push({
    type: "button",
    text: { type: "plain_text", text: "Open report" },
    url: reportUrl,
  });
  return [
    { type: "header", text: { type: "plain_text", text: title } },
    {
      type: "section",
      text: { type: "plain_text", text: `${signal}\n${summary}` },
    },
    { type: "actions", elements: actions },
  ];
}

export function automationDiscordMessage(
  report: ReportMeta,
  reportUrl: string,
): { content: string; components: unknown[] } {
  const title = neutralText(report.title, 150);
  const summary = neutralText(
    report.summary || "Open the report for details.",
    1200,
  );
  const signal = `${report.urgency} urgency · ${report.confidence} confidence`;
  return {
    content: `**${title}**\n${signal}\n${summary}`,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Open report", url: reportUrl },
        ],
      },
    ],
  };
}

async function deliverSlackOutput(
  output: SlackAutomationOutput,
  report: ReportMeta,
  reportUrl: string,
): Promise<void> {
  const title = neutralText(report.title, 150);
  const summary = neutralText(
    report.summary || "Open the report for details.",
    1200,
  );
  const signal = `${report.urgency} urgency · ${report.confidence} confidence`;
  const { postSlackBlocks } = await import("../agents/slack/slack-api");
  const response = await postSlackBlocks(
    output.channel,
    `${title}: ${signal}\n${summary}\n${reportUrl}`,
    automationSlackBlocks(report, reportUrl),
  );
  if (!response?.ok)
    throw new Error(
      `Slack output failed: ${response?.error || "unknown error"}`,
    );
}

async function deliverDiscordOutput(
  output: DiscordAutomationOutput,
  report: ReportMeta,
  reportUrl: string,
): Promise<void> {
  const [{ DiscordRest }, { loadDiscordConfig }] = await Promise.all([
    import("../agents/discord/api"),
    import("../agents/discord/config"),
  ]);
  const config = loadDiscordConfig();
  const rest = new DiscordRest(config.token, config.applicationId);
  const channel = await rest.channel(output.channel);
  if (!channel.guild_id || !config.guildIds.includes(channel.guild_id))
    throw new Error("Discord output channel is outside the allowed guilds");
  if (config.channelIds.length && !config.channelIds.includes(output.channel))
    throw new Error("Discord output channel is not in the channel allowlist");
  const message = automationDiscordMessage(report, reportUrl);
  await rest.sendMessage(
    output.channel,
    message.content,
    undefined,
    undefined,
    message.components,
  );
}

/**
 * Validate required reports and deliver enabled downstream sinks. Disabled
 * message outputs make no network calls. Receipts dedupe successful deliveries.
 */
export async function deliverAutomationOutputs(opts: {
  automationId: string;
  outputs?: AutomationOutput[];
  sessionId: string;
  startedAt: Date;
}): Promise<void> {
  if (!opts.outputs?.length) return;
  const reports = listReportsForSession(opts.sessionId).filter(
    (report) => Date.parse(report.createdAt) >= opts.startedAt.getTime(),
  );
  const latest = reports[0];
  const requiredReport = opts.outputs.some(
    (output) =>
      output.enabled !== false &&
      (output.type !== "report" || (output.publish || "always") === "always"),
  );
  if (requiredReport && !latest)
    throw new Error("Required report output was not published");
  if (!latest) return;

  for (const output of opts.outputs) {
    if (output.type === "report" || output.enabled === false) continue;
    if (!reportMeetsThreshold(latest, output)) continue;
    const state = readOutputState(opts.automationId);
    if (state.delivered[output.id]?.reportId === latest.id) continue;
    const reportUrl = `${configuredServer().publicBaseUrl.replace(/\/+$/, "")}/reports/${encodeURIComponent(latest.automationId)}/${encodeURIComponent(latest.id)}`;
    if (output.type === "slack")
      await deliverSlackOutput(output, latest, reportUrl);
    else await deliverDiscordOutput(output, latest, reportUrl);
    const next = readOutputState(opts.automationId);
    next.delivered[output.id] = {
      reportId: latest.id,
      at: new Date().toISOString(),
    };
    writeJsonAtomic(outputStateFile(opts.automationId), next);
  }
}
