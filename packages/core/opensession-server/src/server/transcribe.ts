/**
 * Voice dictation: turn a short audio clip from the composer mic into text.
 *
 * Hosted providers take the original MediaRecorder container. The local
 * whisper.cpp fallback uses ffmpeg to normalize it to 16 kHz mono WAV. Set
 * OPENSESSION_TRANSCRIPTION_PROVIDER to choose one provider, or leave it on
 * auto to try configured hosted providers before whisper.cpp.
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir } from "./paths";

const WHISPER_CLI =
  process.env.WHISPER_CLI ||
  join(homeDir(), "tools/whisper.cpp/build/bin/whisper-cli");
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  join(homeDir(), "tools/whisper.cpp/models/ggml-small-q5_1.bin");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_MODEL = "gemini-3.5-transcribe";
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

type TranscriptionProvider = "gemini" | "openai" | "groq" | "local";
type TranscriptionProviderSelection = "auto" | TranscriptionProvider;
type TranscriptionResult = { text: string; provider: string };
type GeminiFile = { name: string; uri: string };

/** Max clip we accept. Dictation is not intended for podcasts. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function extForMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a"))
    return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

function geminiMimeType(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase();
  switch (base) {
    case "audio/wav":
    case "audio/mp3":
    case "audio/aiff":
    case "audio/aac":
    case "audio/ogg":
    case "audio/flac":
    case "audio/mpeg":
    case "audio/m4a":
    case "audio/l16":
    case "audio/opus":
    case "audio/alaw":
    case "audio/mulaw":
    case "audio/webm":
      return base;
    case "audio/mp4":
    case "audio/x-m4a":
    case "video/mp4":
      return "audio/m4a";
    case "audio/x-wav":
      return "audio/wav";
    case "application/ogg":
      return "audio/ogg";
    default:
      return "audio/webm";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requireOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`${operation} ${response.status}: ${body.slice(0, 300)}`);
}

function transcriptionProviderSelection(): TranscriptionProviderSelection {
  const configured =
    process.env.OPENSESSION_TRANSCRIPTION_PROVIDER?.trim().toLowerCase() ||
    "auto";
  switch (configured) {
    case "auto":
    case "gemini":
    case "openai":
    case "groq":
    case "local":
      return configured;
    default:
      throw new Error(
        `invalid OPENSESSION_TRANSCRIPTION_PROVIDER "${configured}"; expected auto, gemini, openai, groq, or local`,
      );
  }
}

function providerOrder(
  selection: TranscriptionProviderSelection,
): TranscriptionProvider[] {
  if (selection !== "auto") return [selection];
  return ["openai", "groq", "gemini", "local"];
}

/** OpenAI-compatible transcription endpoint used by OpenAI and Groq. */
async function transcribeOpenAICompatible({
  endpoint,
  apiKey,
  model,
  audio,
  ext,
}: {
  endpoint: string;
  apiKey: string;
  model: string;
  audio: Blob;
  ext: string;
}): Promise<string> {
  const form = new FormData();
  form.append("file", audio, `audio.${ext}`);
  form.append("model", model);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  await requireOk(response, "transcription request");

  const json: unknown = await response.json();
  if (!isRecord(json) || typeof json.text !== "string") {
    throw new Error("no text in transcription response");
  }
  return json.text.trim();
}

function validatedGoogleUploadUrl(value: string): URL {
  const url = new URL(value);
  const googleApiHost =
    url.hostname === "generativelanguage.googleapis.com" ||
    url.hostname.endsWith(".googleapis.com");
  if (url.protocol !== "https:" || !googleApiHost) {
    throw new Error("Gemini returned an invalid upload URL");
  }
  return url;
}

function parseGeminiFile(value: unknown): GeminiFile {
  if (!isRecord(value) || !isRecord(value.file)) {
    throw new Error("Gemini upload response did not contain a file");
  }
  const { name, uri } = value.file;
  if (
    typeof name !== "string" ||
    !/^files\/[A-Za-z0-9_-]+$/.test(name) ||
    typeof uri !== "string" ||
    uri.length === 0
  ) {
    throw new Error("Gemini upload response contained invalid file metadata");
  }
  return { name, uri };
}

function parseGeminiTranscript(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.outputs)) {
    throw new Error("Gemini transcription response did not contain output");
  }
  const parts: string[] = [];
  for (const output of value.outputs) {
    if (
      isRecord(output) &&
      output.type === "text" &&
      typeof output.text === "string"
    ) {
      parts.push(output.text);
    }
  }
  if (parts.length === 0) {
    throw new Error("Gemini transcription response did not contain text");
  }
  return parts.join("\n").trim();
}

async function uploadGeminiAudio({
  audio,
  mime,
  apiKey,
}: {
  audio: Blob;
  mime: string;
  apiKey: string;
}): Promise<GeminiFile> {
  const startResponse = await fetch(`${GEMINI_API_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(audio.size),
      "X-Goog-Upload-Header-Content-Type": mime,
      "X-Goog-Upload-Protocol": "resumable",
    },
    body: JSON.stringify({ file: { display_name: "Open Session dictation" } }),
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  await requireOk(startResponse, "Gemini upload start");

  const uploadHeader = startResponse.headers.get("x-goog-upload-url");
  if (!uploadHeader) throw new Error("Gemini did not return an upload URL");
  const uploadUrl = validatedGoogleUploadUrl(uploadHeader);

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(audio.size),
      "Content-Type": mime,
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
    },
    body: audio,
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  await requireOk(uploadResponse, "Gemini audio upload");
  const json: unknown = await uploadResponse.json();
  return parseGeminiFile(json);
}

async function deleteGeminiFile(name: string, apiKey: string): Promise<void> {
  const response = await fetch(`${GEMINI_API_BASE}/v1beta/${name}`, {
    method: "DELETE",
    headers: { "X-Goog-Api-Key": apiKey },
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  await requireOk(response, "Gemini file deletion");
}

async function transcribeGemini(
  audio: Blob,
  mime: string,
  apiKey: string,
): Promise<string> {
  const normalizedMime = geminiMimeType(mime);
  const file = await uploadGeminiAudio({
    audio,
    mime: normalizedMime,
    apiKey,
  });
  try {
    const response = await fetch(`${GEMINI_API_BASE}/v1beta/interactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: [
          {
            type: "audio",
            uri: file.uri,
            mime_type: normalizedMime,
          },
        ],
        generation_config: {
          transcription_config: { mode: "smart" },
        },
      }),
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
    await requireOk(response, "Gemini transcription request");
    const json: unknown = await response.json();
    return parseGeminiTranscript(json);
  } finally {
    await deleteGeminiFile(file.name, apiKey).catch(() => {});
  }
}

async function transcribeLocal(audio: Blob, ext: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = join(tmpdir(), `dictate-${stamp}.${ext}`);
  const wavPath = join(tmpdir(), `dictate-${stamp}.wav`);
  try {
    await Bun.write(inPath, audio);
    const ffmpeg = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-i",
        inPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        wavPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await ffmpeg.exited) !== 0) {
      const err = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed: ${err.slice(-300)}`);
    }
    const whisper = Bun.spawn(
      [
        WHISPER_CLI,
        "-m",
        WHISPER_MODEL,
        "-f",
        wavPath,
        "-t",
        "14",
        "-bs",
        "1",
        "-np",
        "-nt",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      whisper.exited,
      new Response(whisper.stdout).text(),
      new Response(whisper.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`whisper-cli failed: ${err.slice(-300)}`);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  } finally {
    void unlink(inPath).catch(() => {});
    void unlink(wavPath).catch(() => {});
  }
}

export async function localWhisperAvailable(): Promise<boolean> {
  return (
    (await Bun.file(WHISPER_CLI).exists()) &&
    (await Bun.file(WHISPER_MODEL).exists())
  );
}

/**
 * Transcribe a dictation clip. Auto mode falls through when a configured
 * provider fails. An explicit provider never sends the clip to another one.
 */
export async function transcribeAudio(
  audio: Blob,
  mime: string,
): Promise<TranscriptionResult> {
  const selection = transcriptionProviderSelection();
  const ext = extForMime(mime);
  const errors: string[] = [];

  for (const provider of providerOrder(selection)) {
    try {
      switch (provider) {
        case "gemini": {
          const apiKey = process.env.GEMINI_API_KEY?.trim();
          if (!apiKey) {
            if (selection === "gemini") {
              errors.push("gemini: GEMINI_API_KEY is not set");
            }
            continue;
          }
          return {
            text: await transcribeGemini(audio, mime, apiKey),
            provider: "gemini",
          };
        }
        case "openai": {
          const apiKey = process.env.OPENAI_API_KEY?.trim();
          if (!apiKey) {
            if (selection === "openai") {
              errors.push("openai: OPENAI_API_KEY is not set");
            }
            continue;
          }
          return {
            text: await transcribeOpenAICompatible({
              endpoint: "https://api.openai.com/v1/audio/transcriptions",
              apiKey,
              model: "gpt-4o-mini-transcribe",
              audio,
              ext,
            }),
            provider: "openai",
          };
        }
        case "groq": {
          const apiKey = process.env.GROQ_API_KEY?.trim();
          if (!apiKey) {
            if (selection === "groq") {
              errors.push("groq: GROQ_API_KEY is not set");
            }
            continue;
          }
          return {
            text: await transcribeOpenAICompatible({
              endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
              apiKey,
              model: "whisper-large-v3-turbo",
              audio,
              ext,
            }),
            provider: "groq",
          };
        }
        case "local": {
          if (!(await localWhisperAvailable())) {
            if (selection === "local") {
              errors.push("local: whisper.cpp binary or model is missing");
            }
            continue;
          }
          return {
            text: await transcribeLocal(audio, ext),
            provider: "whisper.cpp",
          };
        }
      }
    } catch (error) {
      errors.push(`${provider}: ${errorMessage(error)}`);
    }
  }

  const detail =
    errors.join("; ") ||
    "no provider configured; set GEMINI_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY, or install whisper.cpp";
  throw new Error(`transcription failed: ${detail}`);
}
