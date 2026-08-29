/** Durable, per-OpenSession state used by subscription-backed ACP CLIs. */
import { createHash } from "crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { sessionsDir } from "./paths";
import type { AcpProvider } from "./acp-config";
import { writeJsonAtomic } from "./shared/atomic-write";

function sessionStateKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function acpSessionStateDir(sessionId: string): string {
  return join(sessionsDir(), "acp-state", sessionStateKey(sessionId));
}

export function acpProviderStateDir(
  sessionId: string,
  provider: AcpProvider,
): string {
  const directory = join(acpSessionStateDir(sessionId), provider);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function bindingPath(sessionId: string, provider: AcpProvider): string {
  return join(acpProviderStateDir(sessionId, provider), "account.json");
}

/** Account that owns the provider-native session currently stored here. */
export function readAcpAccountBinding(
  sessionId: string,
  provider: AcpProvider,
): string | undefined {
  try {
    const value = JSON.parse(
      readFileSync(bindingPath(sessionId, provider), "utf8"),
    );
    return typeof value?.accountId === "string" ? value.accountId : undefined;
  } catch {
    return undefined;
  }
}

export function writeAcpAccountBinding(
  sessionId: string,
  provider: AcpProvider,
  accountId: string,
): void {
  writeJsonAtomic(
    bindingPath(sessionId, provider),
    { accountId, updatedAt: new Date().toISOString() },
    true,
    0o600,
  );
}

function exhaustedPath(sessionId: string, provider: AcpProvider): string {
  return join(
    acpProviderStateDir(sessionId, provider),
    "accounts-exhausted.json",
  );
}

export function recordAcpSessionAccountExhausted(
  sessionId: string,
  provider: AcpProvider,
  accountId: string,
  until = Date.now() + 60 * 60 * 1000,
): void {
  const current: Record<string, number> = {};
  try {
    Object.assign(
      current,
      JSON.parse(readFileSync(exhaustedPath(sessionId, provider), "utf8")),
    );
  } catch {}
  current[accountId] = until;
  writeJsonAtomic(exhaustedPath(sessionId, provider), current, true, 0o600);
}

export function acpSessionExhaustedAccounts(
  sessionId: string,
  provider: AcpProvider,
): Set<string> {
  try {
    const parsed = JSON.parse(
      readFileSync(exhaustedPath(sessionId, provider), "utf8"),
    );
    const now = Date.now();
    return new Set(
      Object.entries(parsed || {})
        .filter(([, until]) => typeof until === "number" && until > now)
        .map(([id]) => id),
    );
  } catch {
    return new Set();
  }
}

export function removeAcpSessionState(sessionId: string): void {
  try {
    rmSync(acpSessionStateDir(sessionId), { recursive: true, force: true });
  } catch {}
}
