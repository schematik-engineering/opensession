// Models chosen from the picker, newest first. The list follows the person
// across devices through ui-prefs, with localStorage as the synchronous cache.
// Keep more than the three rows the picker shows so unavailable models do not
// leave gaps when a workspace exposes a smaller catalog.

import { makeUserPref, type UserPref } from "./user-pref";
import { canonicalModelId } from "./model-engine";

const LOCAL_KEY = "opensession-recent-models";
const PREF_KEY = "recent-models";
const CHANGE_EVENT = "opensession-recent-models-changed";
const EMPTY = "[]";
export const RECENT_MODEL_LIMIT = 12;

export function decodeRecentModels(
  raw: string | null | undefined,
): string[] | null {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return [
      ...new Set(
        value
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .map(canonicalModelId),
      ),
    ].slice(0, RECENT_MODEL_LIMIT);
  } catch {
    return null;
  }
}

export function addRecentModel(models: string[], id: string): string[] {
  if (!id) return models.slice(0, RECENT_MODEL_LIMIT);
  const canonical = canonicalModelId(id);
  return [
    canonical,
    ...models.filter((model) => canonicalModelId(model) !== canonical),
  ].slice(0, RECENT_MODEL_LIMIT);
}

let store: UserPref<string> | undefined;

function prefStore(): UserPref<string> {
  if (!store) {
    store = makeUserPref<string>({
      localKey: LOCAL_KEY,
      prefKey: PREF_KEY,
      changeEvent: CHANGE_EVENT,
      defaultValue: EMPTY,
      decode: (raw) => {
        const models = decodeRecentModels(raw);
        return models === null ? null : JSON.stringify(models);
      },
      encode: (value) => value,
    });
  }
  return store;
}

export function getRecentModels(): string[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined")
    return [];
  return decodeRecentModels(prefStore().get()) ?? [];
}

export function pushRecentModel(id: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined")
    return;
  prefStore().set(JSON.stringify(addRecentModel(getRecentModels(), id)));
}

export function onRecentModelsChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  return prefStore().onChanged(handler);
}
