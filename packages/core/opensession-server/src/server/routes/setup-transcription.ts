import { audit } from "../audit";
import { withConfigMutationLock } from "../config-mutation";
import {
  applyEnvFileEdits,
  readEnvFileValues,
  validateEnvValue,
} from "../env-file-edit";
import type { RouteContext } from "./context";

type TranscriptionProvider = "auto" | "gemini" | "openai" | "groq" | "local";

function parseTranscriptionProvider(value: string): TranscriptionProvider {
  switch (value.trim().toLowerCase()) {
    case "gemini":
      return "gemini";
    case "openai":
      return "openai";
    case "groq":
      return "groq";
    case "local":
      return "local";
    default:
      return "auto";
  }
}

function transcriptionEnvValue(
  name: string,
  envValues: Record<string, string>,
): string {
  return Object.hasOwn(envValues, name)
    ? envValues[name]
    : (process.env[name] ?? "");
}

/** Presence-only setup state. The API key itself never leaves the server. */
export function transcriptionSnapshot(envValues: Record<string, string>) {
  const apiKey = transcriptionEnvValue("GEMINI_API_KEY", envValues).trim();
  return {
    provider: parseTranscriptionProvider(
      transcriptionEnvValue("OPENSESSION_TRANSCRIPTION_PROVIDER", envValues),
    ),
    geminiApiKeyConfigured: apiKey.length > 0,
    ...(apiKey ? { geminiApiKeyMasked: `••••${apiKey.slice(-4)}` } : {}),
  };
}

/** Admin authorization runs in the parent setup router before this handler. */
export async function handleSetupTranscriptionRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path !== "/api/setup/transcription" || req.method !== "PUT") {
    return undefined;
  }

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const provider = "provider" in body ? body.provider : undefined;
  const geminiApiKey = "geminiApiKey" in body ? body.geminiApiKey : undefined;
  if (provider === undefined && geminiApiKey === undefined) {
    return Response.json({ error: "Nothing to change" }, { status: 400 });
  }
  if (
    provider !== undefined &&
    (typeof provider !== "string" ||
      parseTranscriptionProvider(provider) !== provider.trim().toLowerCase())
  ) {
    return Response.json(
      { error: "provider must be auto, gemini, openai, groq, or local" },
      { status: 400 },
    );
  }
  if (geminiApiKey !== undefined) {
    const invalid = validateEnvValue(geminiApiKey);
    if (invalid) {
      return Response.json(
        { error: `geminiApiKey: ${invalid}` },
        { status: 400 },
      );
    }
  }

  return withConfigMutationLock(async () => {
    const envValues = readEnvFileValues({ includeUnset: true });
    const current = transcriptionSnapshot(envValues);
    const nextApiKey =
      typeof geminiApiKey === "string"
        ? geminiApiKey.trim()
        : transcriptionEnvValue("GEMINI_API_KEY", envValues).trim();
    const requestedProvider =
      typeof provider === "string"
        ? parseTranscriptionProvider(provider)
        : undefined;
    const nextProvider = requestedProvider
      ? requestedProvider
      : nextApiKey
        ? "gemini"
        : current.provider === "gemini"
          ? "auto"
          : current.provider;
    if (nextProvider === "gemini" && !nextApiKey) {
      return Response.json(
        { error: "Add a Gemini API key before selecting Gemini" },
        { status: 409 },
      );
    }

    const edits: Record<string, string> = {};
    if (typeof geminiApiKey === "string") {
      edits.GEMINI_API_KEY = nextApiKey;
    }
    if (provider !== undefined || nextProvider !== current.provider) {
      edits.OPENSESSION_TRANSCRIPTION_PROVIDER = nextProvider;
    }
    applyEnvFileEdits(edits);

    if (Object.hasOwn(edits, "GEMINI_API_KEY")) {
      if (nextApiKey) process.env.GEMINI_API_KEY = nextApiKey;
      else delete process.env.GEMINI_API_KEY;
    }
    if (Object.hasOwn(edits, "OPENSESSION_TRANSCRIPTION_PROVIDER")) {
      process.env.OPENSESSION_TRANSCRIPTION_PROVIDER = nextProvider;
    }
    audit({
      kind: "setup_transcription_update",
      fields: Object.keys(edits),
      by: ctx.authUser?.login || null,
    });
    return Response.json({
      transcription: transcriptionSnapshot(
        readEnvFileValues({ includeUnset: true }),
      ),
      restartRequired: false,
    });
  });
}
