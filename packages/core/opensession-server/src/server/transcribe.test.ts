import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { transcribeAudio } from "./transcribe";

const originalFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchHandler = (input: FetchInput, init?: FetchInit) => Promise<Response>;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
}

const originalEnv = {
  provider: process.env.OPENSESSION_TRANSCRIPTION_PROVIDER,
  gemini: process.env.GEMINI_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  groq: process.env.GROQ_API_KEY,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env.OPENSESSION_TRANSCRIPTION_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GROQ_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("OPENSESSION_TRANSCRIPTION_PROVIDER", originalEnv.provider);
  restoreEnv("GEMINI_API_KEY", originalEnv.gemini);
  restoreEnv("OPENAI_API_KEY", originalEnv.openai);
  restoreEnv("GROQ_API_KEY", originalEnv.groq);
});

describe("transcribeAudio", () => {
  test("uses Gemini 3.5 Transcribe and deletes the uploaded audio", async () => {
    process.env.OPENSESSION_TRANSCRIPTION_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "gemini-secret";
    const audio = new Blob(["audio bytes"], {
      type: "audio/webm;codecs=opus",
    });
    const calls: Array<{ url: string; init: FetchInit }> = [];

    installFetch(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      switch (calls.length) {
        case 1:
          return new Response(null, {
            headers: {
              "x-goog-upload-url":
                "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=clip",
            },
          });
        case 2:
          return Response.json({
            file: {
              name: "files/clip_123",
              uri: "https://generativelanguage.googleapis.com/v1beta/files/clip_123",
            },
          });
        case 3:
          return Response.json({
            outputs: [{ type: "text", text: "Ship the transcription." }],
          });
        case 4:
          return new Response(null, { status: 204 });
        default:
          throw new Error(`unexpected fetch: ${url}`);
      }
    });

    await expect(
      transcribeAudio(audio, "audio/webm;codecs=opus"),
    ).resolves.toEqual({
      text: "Ship the transcription.",
      provider: "gemini",
    });

    expect(calls.map(({ url }) => url)).toEqual([
      "https://generativelanguage.googleapis.com/upload/v1beta/files",
      "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=clip",
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      "https://generativelanguage.googleapis.com/v1beta/files/clip_123",
    ]);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("x-goog-api-key")).toBe(
      "gemini-secret",
    );
    expect(
      new Headers(calls[0]?.init?.headers).get(
        "x-goog-upload-header-content-type",
      ),
    ).toBe("audio/webm");
    expect(calls[1]?.init?.body).toBe(audio);
    expect(calls[2]?.init?.body).toBe(
      JSON.stringify({
        model: "gemini-3.5-transcribe",
        input: [
          {
            type: "audio",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/clip_123",
            mime_type: "audio/webm",
          },
        ],
        generation_config: {
          transcription_config: { mode: "smart" },
        },
      }),
    );
    expect(calls[3]?.init?.method).toBe("DELETE");
  });

  test("deletes Gemini audio when transcription fails", async () => {
    process.env.OPENSESSION_TRANSCRIPTION_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "gemini-secret";
    const methods: string[] = [];
    const uploadMimes: Array<string | null> = [];

    installFetch(async (_input, init) => {
      methods.push(init?.method || "GET");
      if (methods.length === 1) {
        uploadMimes.push(
          new Headers(init?.headers).get("x-goog-upload-header-content-type"),
        );
      }
      switch (methods.length) {
        case 1:
          return new Response(null, {
            headers: {
              "x-goog-upload-url":
                "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=failed",
            },
          });
        case 2:
          return Response.json({
            file: {
              name: "files/failed_123",
              uri: "https://generativelanguage.googleapis.com/v1beta/files/failed_123",
            },
          });
        case 3:
          return new Response("model unavailable", { status: 503 });
        case 4:
          return new Response(null, { status: 204 });
        default:
          throw new Error("unexpected fetch");
      }
    });

    await expect(
      transcribeAudio(new Blob(["audio"]), "audio/mp4"),
    ).rejects.toThrow(
      "gemini: Gemini transcription request 503: model unavailable",
    );
    expect(methods).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(uploadMimes).toEqual(["audio/m4a"]);
  });

  test("auto mode preserves the existing hosted provider order", async () => {
    process.env.OPENSESSION_TRANSCRIPTION_PROVIDER = "auto";
    process.env.GEMINI_API_KEY = "gemini-secret";
    process.env.OPENAI_API_KEY = "openai-secret";
    const urls: string[] = [];

    installFetch(async (input) => {
      urls.push(String(input));
      return Response.json({ text: "OpenAI text" });
    });

    await expect(
      transcribeAudio(new Blob(["audio"]), "audio/webm"),
    ).resolves.toEqual({ text: "OpenAI text", provider: "openai" });
    expect(urls).toEqual(["https://api.openai.com/v1/audio/transcriptions"]);
  });

  test("an explicit provider does not send audio to a fallback", async () => {
    process.env.OPENSESSION_TRANSCRIPTION_PROVIDER = "gemini";
    process.env.OPENAI_API_KEY = "openai-secret";
    installFetch(async () => {
      throw new Error("fetch should not be called");
    });

    await expect(
      transcribeAudio(new Blob(["audio"]), "audio/webm"),
    ).rejects.toThrow("gemini: GEMINI_API_KEY is not set");
  });

  test("rejects an unknown provider", async () => {
    process.env.OPENSESSION_TRANSCRIPTION_PROVIDER = "other";

    await expect(
      transcribeAudio(new Blob(["audio"]), "audio/webm"),
    ).rejects.toThrow('invalid OPENSESSION_TRANSCRIPTION_PROVIDER "other"');
  });
});
