/** Engine-aware model id helpers shared by every model picker. */
export const ENGINE_IDS = ["pi", "grok", "cursor"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export interface EngineOption {
  id: EngineId;
  label: string;
  available: boolean;
}

const PRESET_HEADS = ["dial/", "orchestrator/", "workspace-preset/"];
const isPresetId = (id: string) =>
  PRESET_HEADS.some((head) => id.startsWith(head));

/** Canonicalize ids retained in browser preferences across provider renames. */
export function canonicalModelId(id: string): string {
  return id.startsWith("pi/vercel/")
    ? `pi/vercel-ai-gateway/${id.slice("pi/vercel/".length)}`
    : id;
}

export function modelEngine(id: string): EngineId {
  if (id.startsWith("grok/")) return "grok";
  if (id.startsWith("cursor/")) return "cursor";
  return "pi";
}

/** Catalog ids are already Pi-routed, so selection lookups use them verbatim. */
export function baseModelId(id: string): string {
  return id;
}

export function modelVendor(id: string): string | null {
  if (id.startsWith("grok/")) return "grok";
  if (id.startsWith("cursor/")) return "cursor";
  const rest = id.startsWith("pi/") ? id.slice(3) : id;
  if (isPresetId(rest)) return null;
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

export function isAnthropicModel(
  id: string,
  accountProvider?: string | null,
): boolean {
  return (
    modelVendor(id) === "anthropic" ||
    (modelVendor(id) === null && accountProvider === "claude")
  );
}

export function engineModelId(_engine: EngineId, id: string): string | null {
  if (!id) return null;
  if (id.startsWith("grok/") || id.startsWith("cursor/")) return id;
  if (id.startsWith("pi/")) return id;
  if (isPresetId(id)) return `pi/${id}`;
  if (id.startsWith("claude-")) return `pi/anthropic/${id}`;
  if (id.startsWith("gpt-") || id.startsWith("codex-"))
    return `pi/openai/${id}`;
  return id.includes("/") ? `pi/${id}` : null;
}

export function piModelId(id: string): string | null {
  return engineModelId("pi", id);
}

export function modelEngineKey(id: string): string {
  if (id.startsWith("grok/") || id.startsWith("cursor/")) return id;
  const rest = id.startsWith("pi/") ? id.slice(3) : id;
  if (isPresetId(rest)) return rest;
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(slash + 1) : rest;
}
