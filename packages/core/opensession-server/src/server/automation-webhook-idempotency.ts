import { createHash } from "crypto";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

const MAX_IDEMPOTENCY_KEY_BYTES = 200;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function receiptsRoot(): string {
  return stateDir("automation-webhook-receipts");
}

function automationDirectory(automationId: string): string {
  return join(receiptsRoot(), automationId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function receiptPath(automationId: string, keyHash: string): string {
  if (!HASH_PATTERN.test(keyHash))
    throw new Error("Invalid webhook idempotency hash");
  return join(automationDirectory(automationId), `${keyHash}.json`);
}

export function parseWebhookIdempotencyKey(
  value: string | null,
): string | { error: string } | undefined {
  if (value === null) return undefined;
  const key = value.trim();
  if (!key) return { error: "Idempotency-Key must not be empty" };
  if (Buffer.byteLength(key, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES)
    return {
      error: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_BYTES} bytes`,
    };
  return key;
}

export function webhookIdempotencyHash(
  automationId: string,
  key: string,
): string {
  return createHash("sha256")
    .update(automationId)
    .update("\0")
    .update(key)
    .digest("hex");
}

export function automationWebhookReceiptExists(
  automationId: string,
  keyHash: string,
): boolean {
  return existsSync(receiptPath(automationId, keyHash));
}

export function persistAutomationWebhookReceipt(input: {
  automationId: string;
  keyHash: string;
  sessionId: string;
  acceptedAt: string;
}): void {
  const path = receiptPath(input.automationId, input.keyHash);
  if (existsSync(path)) return;
  writeJsonAtomic(
    path,
    {
      version: 1,
      automationId: input.automationId,
      keyHash: input.keyHash,
      sessionId: input.sessionId,
      acceptedAt: input.acceptedAt,
    },
    true,
    0o600,
  );
}

export function deleteAutomationWebhookReceipts(automationId: string): void {
  rmSync(automationDirectory(automationId), { recursive: true, force: true });
}
