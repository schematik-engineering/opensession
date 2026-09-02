import type { TranscriptEntry } from "./types";
import { toolResultMedia } from "./transcript-media";

type JsonRecord = Record<string, unknown>;

type PaseoTimelineRow = {
  agentId: string;
  provider: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  item: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function integerField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function parsePaseoTimelineRow(value: unknown): PaseoTimelineRow | null {
  if (!isRecord(value) || value.type !== "paseo_timeline") return null;
  const agentId = stringField(value, "agentId");
  const provider = stringField(value, "provider");
  const timestamp = stringField(value, "timestamp");
  const seqStart = integerField(value, "seqStart");
  const seqEnd = integerField(value, "seqEnd");
  if (
    !agentId ||
    !provider ||
    !timestamp ||
    seqStart === undefined ||
    seqEnd === undefined ||
    seqEnd < seqStart ||
    !isRecord(value.item)
  )
    return null;
  return {
    agentId,
    provider,
    timestamp,
    seqStart,
    seqEnd,
    item: value.item,
  };
}

function stableRowId(row: PaseoTimelineRow, suffix: string): string {
  return `paseo-${row.agentId}-${row.seqStart}-${row.seqEnd}-${suffix}`;
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value ?? "");
  }
}

function optionalFields(
  detail: JsonRecord,
  keys: readonly string[],
): JsonRecord {
  const selected: JsonRecord = {};
  for (const key of keys) {
    if (detail[key] !== undefined) selected[key] = detail[key];
  }
  return selected;
}

function toolInput(detail: JsonRecord): unknown {
  switch (detail.type) {
    case "shell":
      return optionalFields(detail, ["command", "cwd"]);
    case "read":
      return optionalFields(detail, ["filePath", "offset", "limit"]);
    case "edit":
      return optionalFields(detail, [
        "filePath",
        "oldString",
        "newString",
        "unifiedDiff",
      ]);
    case "write":
      return optionalFields(detail, ["filePath", "content"]);
    case "search":
      return optionalFields(detail, ["query", "toolName", "mode"]);
    case "fetch":
      return optionalFields(detail, ["url", "prompt"]);
    case "worktree_setup":
      return optionalFields(detail, ["worktreePath", "branchName", "commands"]);
    case "sub_agent":
      return optionalFields(detail, [
        "subAgentType",
        "description",
        "childSessionId",
      ]);
    case "plain_text":
      return optionalFields(detail, ["label"]);
    case "plan":
      return optionalFields(detail, ["text"]);
    case "unknown":
      return detail.input;
    default:
      return detail;
  }
}

function toolOutput(detail: JsonRecord): string {
  switch (detail.type) {
    case "shell": {
      const output = stringField(detail, "output") ?? "";
      const exitCode = detail.exitCode;
      if (output) return output;
      return typeof exitCode === "number"
        ? `Command exited with code ${exitCode}.`
        : "Command completed.";
    }
    case "read":
      return stringField(detail, "content") ?? "File read completed.";
    case "edit":
      return (
        stringField(detail, "unifiedDiff") ??
        `Edited ${stringField(detail, "filePath") ?? "file"}.`
      );
    case "write":
      return `Wrote ${stringField(detail, "filePath") ?? "file"}.`;
    case "search": {
      const content = stringField(detail, "content");
      if (content) return content;
      const results = optionalFields(detail, [
        "filePaths",
        "webResults",
        "annotations",
        "numFiles",
        "numMatches",
        "truncated",
      ]);
      return Object.keys(results).length > 0
        ? jsonText(results)
        : "Search completed.";
    }
    case "fetch":
      return stringField(detail, "result") ?? "Fetch completed.";
    case "worktree_setup":
      return stringField(detail, "log") ?? "Worktree setup completed.";
    case "sub_agent":
      return stringField(detail, "log") ?? "Sub-agent completed.";
    case "plain_text":
      return stringField(detail, "text") ?? "Tool completed.";
    case "plan":
      return stringField(detail, "text") ?? "Plan updated.";
    case "unknown":
      return jsonText(detail.output) || "Tool completed.";
    default:
      return jsonText(detail) || "Tool completed.";
  }
}

function toolCallEntries(row: PaseoTimelineRow): TranscriptEntry[] {
  const item = row.item;
  const callId = stringField(item, "callId");
  const name = stringField(item, "name");
  const detail = isRecord(item.detail) ? item.detail : null;
  const status = stringField(item, "status");
  if (
    !callId ||
    !name ||
    !detail ||
    !status ||
    !["running", "completed", "failed", "canceled"].includes(status)
  )
    return [];

  const entries: TranscriptEntry[] = [
    {
      id: stableRowId(row, "tool-use"),
      type: "tool_use",
      content: `Using ${name}`,
      timestamp: row.timestamp,
      toolName: name,
      toolInput: toolInput(detail),
      toolUseId: callId,
    },
  ];
  if (status === "running") return entries;

  const failed = status === "failed";
  const canceled = status === "canceled";
  const detailOutput = toolOutput(detail);
  const error = failed ? jsonText(item.error) : "";
  const content = canceled
    ? "Tool call canceled."
    : error
      ? [detailOutput, error].filter(Boolean).join("\n\n")
      : detailOutput;
  entries.push({
    id: stableRowId(row, "tool-result"),
    type: "tool_result",
    content,
    timestamp: row.timestamp,
    toolUseId: callId,
    ...(failed ? { isError: true } : {}),
    ...toolResultMedia(content),
  });
  return entries;
}

function parsePaseoTimelineItem(row: PaseoTimelineRow): TranscriptEntry[] {
  const item = row.item;
  switch (item.type) {
    case "user_message": {
      const text = stringField(item, "text");
      return text
        ? [
            {
              id: stableRowId(row, "user"),
              type: "user",
              content: text,
              timestamp: row.timestamp,
            },
          ]
        : [];
    }
    case "assistant_message": {
      const text = stringField(item, "text");
      return text
        ? [
            {
              id: stableRowId(row, "assistant"),
              type: "assistant",
              content: text,
              timestamp: row.timestamp,
            },
          ]
        : [];
    }
    case "reasoning": {
      const text = stringField(item, "text");
      return text
        ? [
            {
              id: stableRowId(row, "reasoning"),
              type: "assistant",
              content: text,
              timestamp: row.timestamp,
              isReasoning: true,
            },
          ]
        : [];
    }
    case "tool_call":
      return toolCallEntries(row);
    case "todo":
      return [
        {
          id: stableRowId(row, "todo"),
          type: "system",
          content: `Tasks\n\n${jsonText(item.items)}`,
          timestamp: row.timestamp,
        },
      ];
    case "error": {
      const message = stringField(item, "message");
      return message
        ? [
            {
              id: stableRowId(row, "error"),
              type: "system",
              content: message,
              timestamp: row.timestamp,
            },
          ]
        : [];
    }
    case "compaction":
      return item.status === "completed"
        ? [
            {
              id: stableRowId(row, "compaction"),
              type: "system",
              content: "Paseo compacted the conversation.",
              timestamp: row.timestamp,
            },
          ]
        : [];
    default:
      return [];
  }
}

export async function parsePaseoLinesAsync(
  lines: string[],
  yieldEveryLines = 1000,
): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && index % yieldEveryLines === 0) await Bun.sleep(0);
    try {
      const row = parsePaseoTimelineRow(JSON.parse(lines[index]));
      if (row) entries.push(...parsePaseoTimelineItem(row));
    } catch {
      continue;
    }
  }
  return entries;
}
