/** Durable, per-OpenSession state used by subscription-backed ACP CLIs. */
import { createHash } from "crypto";
import { chmodSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { sessionsDir } from "./paths";
import type { AcpProvider } from "./acp-config";

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

export function removeAcpSessionState(sessionId: string): void {
  try {
    rmSync(acpSessionStateDir(sessionId), { recursive: true, force: true });
  } catch {}
}
