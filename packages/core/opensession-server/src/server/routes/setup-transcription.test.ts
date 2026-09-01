import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "./context";
import { handleSetupRoutes } from "./setup";

const savedEnv = {
  config: process.env.OPENSESSION_CONFIG,
  envFile: process.env.OPENSESSION_ENV_FILE,
  geminiApiKey: process.env.GEMINI_API_KEY,
  provider: process.env.OPENSESSION_TRANSCRIPTION_PROVIDER,
};
const dirs: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function prepareConfig(): string {
  const dir = mkdtempSync(
    join(tmpdir(), "opensession-transcription-settings-"),
  );
  dirs.push(dir);
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  process.env.OPENSESSION_ENV_FILE = join(dir, ".opensession.env");
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({ integrations: {} }),
  );
  return process.env.OPENSESSION_ENV_FILE;
}

function context(body: unknown): RouteContext {
  const url = new URL("http://localhost/api/setup/transcription");
  return {
    req: new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: { login: "admin", name: "Admin" },
  };
}

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENSESSION_TRANSCRIPTION_PROVIDER;
});

afterEach(() => {
  restoreEnv("OPENSESSION_CONFIG", savedEnv.config);
  restoreEnv("OPENSESSION_ENV_FILE", savedEnv.envFile);
  restoreEnv("GEMINI_API_KEY", savedEnv.geminiApiKey);
  restoreEnv("OPENSESSION_TRANSCRIPTION_PROVIDER", savedEnv.provider);
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("transcription setup", () => {
  test("stores a Gemini key without returning it and applies it immediately", async () => {
    const envFile = prepareConfig();
    const response = await handleSetupRoutes(
      context({
        provider: "gemini",
        geminiApiKey: "AIza-demo-1234",
      }),
    );
    const payload: unknown = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toEqual({
      transcription: {
        provider: "gemini",
        geminiApiKeyConfigured: true,
        geminiApiKeyMasked: "••••1234",
      },
      restartRequired: false,
    });
    expect(JSON.stringify(payload)).not.toContain("AIza-demo-1234");
    expect(readFileSync(envFile, "utf8")).toContain(
      "GEMINI_API_KEY=AIza-demo-1234",
    );
    expect(readFileSync(envFile, "utf8")).toContain(
      "OPENSESSION_TRANSCRIPTION_PROVIDER=gemini",
    );
    expect(process.env.GEMINI_API_KEY).toBe("AIza-demo-1234");
    expect(process.env.OPENSESSION_TRANSCRIPTION_PROVIDER).toBe("gemini");
  });

  test("falls back to automatic selection when the active Gemini key is removed", async () => {
    prepareConfig();
    await handleSetupRoutes(
      context({
        provider: "gemini",
        geminiApiKey: "AIza-demo-1234",
      }),
    );

    const response = await handleSetupRoutes(context({ geminiApiKey: "" }));
    const payload: unknown = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toEqual({
      transcription: {
        provider: "auto",
        geminiApiKeyConfigured: false,
      },
      restartRequired: false,
    });
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    expect(process.env.OPENSESSION_TRANSCRIPTION_PROVIDER).toBe("auto");
  });

  test("rejects Gemini selection until a key is configured", async () => {
    prepareConfig();

    const response = await handleSetupRoutes(context({ provider: "gemini" }));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "Add a Gemini API key before selecting Gemini",
    });
  });

  test("rejects unknown providers", async () => {
    prepareConfig();

    const response = await handleSetupRoutes(context({ provider: "other" }));

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "provider must be auto, gemini, openai, groq, or local",
    });
  });
});
