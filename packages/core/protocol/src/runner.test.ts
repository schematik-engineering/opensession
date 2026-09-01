import { describe, expect, test } from "bun:test";
import {
  BoundedDeliveryReceipts,
  type ClientToHostMsg,
  type HostToClientMsg,
} from "./runner";

describe("bounded delivery receipts", () => {
  test("retains recent receipts and evicts the oldest one", () => {
    const receipts = new BoundedDeliveryReceipts(2);

    receipts.add("delivery-1");
    receipts.add("delivery-2");
    receipts.add("delivery-3");

    expect(receipts.has("delivery-1")).toBe(false);
    expect(receipts.has("delivery-2")).toBe(true);
    expect(receipts.has("delivery-3")).toBe(true);
  });

  test("does not evict another receipt when a duplicate arrives", () => {
    const receipts = new BoundedDeliveryReceipts(2);

    receipts.add("delivery-1");
    receipts.add("delivery-2");
    receipts.add("delivery-1");

    expect(receipts.has("delivery-1")).toBe(true);
    expect(receipts.has("delivery-2")).toBe(true);
  });
});

describe("ask answer delivery protocol", () => {
  test("accepts a legacy answer without a delivery id", () => {
    const answer = {
      t: "ask_answer",
      askId: "ask-1",
      result: { behavior: "deny", message: "No" },
    } satisfies ClientToHostMsg;

    expect(answer).not.toHaveProperty("deliveryId");
  });

  test("carries both identities in the host acknowledgement", () => {
    const acknowledgement = {
      t: "ask_answer_ack",
      askId: "ask-1",
      deliveryId: "delivery-1",
    } satisfies HostToClientMsg;

    expect(acknowledgement).toEqual({
      t: "ask_answer_ack",
      askId: "ask-1",
      deliveryId: "delivery-1",
    });
  });
});
