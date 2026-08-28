import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readPiNativeTranscript } from "./pi-native-transcript";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readPiNativeTranscript", () => {
  test("keeps assistant thinking and text visible in provider order", () => {
    dir = mkdtempSync(join(tmpdir(), "opensession-pi-transcript-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "message",
        id: "message-1",
        timestamp: "2026-08-24T12:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should inspect the repository." },
            {
              type: "toolCall",
              id: "tool-1",
              name: "read",
              arguments: { path: "README.md" },
            },
            { type: "text", text: "The repository is ready." },
          ],
        },
      }) + "\n",
    );

    expect(readPiNativeTranscript(path)).toEqual([
      {
        id: "message-1",
        type: "assistant",
        content: "I should inspect the repository.",
        timestamp: "2026-08-24T12:00:00.000Z",
        isReasoning: true,
      },
      {
        id: "tool-1",
        type: "tool_use",
        content: "Using read",
        timestamp: "2026-08-24T12:00:00.000Z",
        toolName: "read",
        toolInput: { path: "README.md" },
        toolUseId: "tool-1",
      },
      {
        id: "message-1-b1",
        type: "assistant",
        content: "The repository is ready.",
        timestamp: "2026-08-24T12:00:00.000Z",
      },
    ]);
  });
});
