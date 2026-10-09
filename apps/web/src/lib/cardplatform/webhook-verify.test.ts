import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  webhookBodyOnlySignatureAllowed,
  webhookSignatureMatches,
  webhookTimestampSkewOk,
} from "./webhook-verify";

const NOW = 1_710_000_000_000;

describe("webhookTimestampSkewOk", () => {
  it("accepts seconds and milliseconds inside the window", () => {
    expect(webhookTimestampSkewOk("1710000000", NOW)).toBe(true);
    expect(webhookTimestampSkewOk("1710000299", NOW)).toBe(true);
    expect(webhookTimestampSkewOk("1710000000000", NOW)).toBe(true);
  });

  it("rejects timestamps outside the window", () => {
    expect(webhookTimestampSkewOk("1710000301", NOW)).toBe(false);
    expect(webhookTimestampSkewOk("1709999000", NOW)).toBe(false);
  });

  it("rejects non-numeric timestamps", () => {
    for (const bad of ["", "abc", "1710000000.5", "-1710000000", "1e9", " ", "Infinity"]) {
      expect(webhookTimestampSkewOk(bad, NOW)).toBe(false);
    }
  });
});

describe("webhookBodyOnlySignatureAllowed", () => {
  it("defaults to off", () => {
    expect(webhookBodyOnlySignatureAllowed({})).toBe(false);
    expect(
      webhookBodyOnlySignatureAllowed({ CARDPLATFORM_WEBHOOK_ALLOW_BODY_ONLY_SIGNATURE: "0" }),
    ).toBe(false);
  });

  it("turns on with an explicit flag", () => {
    expect(
      webhookBodyOnlySignatureAllowed({ CARDPLATFORM_WEBHOOK_ALLOW_BODY_ONLY_SIGNATURE: "true" }),
    ).toBe(true);
  });
});

describe("webhookSignatureMatches", () => {
  const secret = "whsec_test";
  const raw = Buffer.from('{"event":"gpt_direct.completed"}', "utf8");
  const bodySig = createHmac("sha256", secret).update(raw).digest("hex");
  const tsSig = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from("1710000000."), raw]))
    .digest("hex");

  it("rejects body-only signature by default even when a timestamp is present", () => {
    expect(webhookSignatureMatches(secret, raw, [], [bodySig])).toBe(false);
    expect(webhookSignatureMatches(secret, raw, ["1710000000"], [bodySig])).toBe(false);
  });

  it("accepts body-only signature when allowed", () => {
    expect(
      webhookSignatureMatches(secret, raw, [], [bodySig], { allowBodyOnly: true }),
    ).toBe(true);
  });

  it("accepts timestamped signature", () => {
    expect(webhookSignatureMatches(secret, raw, ["1710000000"], [`v1=${tsSig}`])).toBe(true);
    expect(webhookSignatureMatches(secret, raw, ["1710000001"], [tsSig])).toBe(false);
  });
});
