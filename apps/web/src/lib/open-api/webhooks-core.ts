import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_EVENTS = ["redemption.succeeded", "redemption.failed"] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** 第 1 到第 5 次失败后的等待：1 分钟、5 分钟、30 分钟、2 小时、12 小时。第 5 次之后不再投。 */
export const WEBHOOK_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

export function webhookEventForStatus(status: string): WebhookEventName | null {
  if (status === "success") return "redemption.succeeded";
  if (status === "failed") return "redemption.failed";
  return null;
}

export function webhookBackoffMs(attempt: number) {
  return WEBHOOK_BACKOFF_MS[attempt - 1] ?? null;
}

export function signWebhookBody(secret: string, body: string, unixSeconds: number) {
  const v1 = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${v1}`;
}

export function verifyWebhookSignature(secret: string, body: string, header: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value || ""];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1 || "";
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > 300) return false;
  const expected = signWebhookBody(secret, body, t).split("v1=")[1] || "";
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
