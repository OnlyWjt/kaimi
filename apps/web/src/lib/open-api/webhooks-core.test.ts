import { describe, expect, it } from "vitest";
import {
  signWebhookBody,
  verifyWebhookSignature,
  webhookBackoffMs,
  webhookEventForStatus,
} from "./webhooks-core";

describe("webhook signature", () => {
  it("accepts a signature inside five minutes", () => {
    const body = JSON.stringify({ event: "redemption.succeeded" });
    const header = signWebhookBody("secret", body, 1_700_000_000);
    expect(verifyWebhookSignature("secret", body, header, 1_700_000_100)).toBe(true);
  });

  it("rejects a stale or altered body", () => {
    const header = signWebhookBody("secret", "body", 1_700_000_000);
    expect(verifyWebhookSignature("secret", "body", header, 1_700_000_400)).toBe(false);
    expect(verifyWebhookSignature("secret", "other", header, 1_700_000_000)).toBe(false);
  });
});

describe("webhook schedule", () => {
  it("maps terminal statuses and stops after five attempts", () => {
    expect(webhookEventForStatus("success")).toBe("redemption.succeeded");
    expect(webhookEventForStatus("failed")).toBe("redemption.failed");
    expect(webhookEventForStatus("unknown")).toBeNull();
    expect(webhookBackoffMs(1)).toBe(60_000);
    expect(webhookBackoffMs(5)).toBe(43_200_000);
    expect(webhookBackoffMs(6)).toBeNull();
  });
});
