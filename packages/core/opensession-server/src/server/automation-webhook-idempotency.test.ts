import { afterEach, describe, expect, test } from "bun:test";
import {
  automationWebhookReceiptExists,
  deleteAutomationWebhookReceipts,
  parseWebhookIdempotencyKey,
  persistAutomationWebhookReceipt,
  webhookIdempotencyHash,
} from "./automation-webhook-idempotency";

const automationId = `test-webhook-idempotency-${process.pid}`;

afterEach(() => deleteAutomationWebhookReceipts(automationId));

describe("automation webhook idempotency", () => {
  test("validates bounded optional keys", () => {
    expect(parseWebhookIdempotencyKey(null)).toBeUndefined();
    expect(parseWebhookIdempotencyKey(" feedback-id ")).toBe("feedback-id");
    expect(parseWebhookIdempotencyKey(" ")).toEqual({
      error: "Idempotency-Key must not be empty",
    });
    expect(parseWebhookIdempotencyKey("x".repeat(201))).toEqual({
      error: "Idempotency-Key must be at most 200 bytes",
    });
  });

  test("persists an automation-scoped receipt without storing the raw key", () => {
    const key = "821d2e40-b3a7-44df-9d25-37d70ae1761a";
    const keyHash = webhookIdempotencyHash(automationId, key);
    const otherHash = webhookIdempotencyHash(`${automationId}-other`, key);
    expect(keyHash).not.toBe(otherHash);
    expect(automationWebhookReceiptExists(automationId, keyHash)).toBe(false);

    persistAutomationWebhookReceipt({
      automationId,
      keyHash,
      sessionId: "os-test-idempotency",
      acceptedAt: "2026-09-01T14:00:00.000Z",
    });

    expect(automationWebhookReceiptExists(automationId, keyHash)).toBe(true);
    expect(automationWebhookReceiptExists(automationId, otherHash)).toBe(false);
  });
});
