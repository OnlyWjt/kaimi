import type { ItemStatus } from "@/lib/recharge-types";

function payloadStatus(payload: Record<string, unknown>) {
  const data =
    typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : {};
  const raw = payload.status ?? data.status ?? "";
  return String(raw).toLowerCase();
}

export function mapCardplatformStatus(
  payload: Record<string, unknown>,
  responseOk: boolean,
): ItemStatus {
  const raw = payloadStatus(payload);
  if (["success", "completed", "fulfilled"].includes(raw)) return "success";
  if (raw === "skipped") return "skipped";
  if (["failed", "error", "cancelled"].includes(raw)) return "failed";
  if (["expired", "canceled", "unknown"].includes(raw)) return "unknown";
  if (["processing", "running", "submitted"].includes(raw)) return "processing";
  const businessCode = Number(payload.code || 0);
  if (businessCode && ![1, 200].includes(businessCode)) return "unknown";
  return responseOk ? "pending" : "failed";
}

export function requestIdForRedeem(accountId: number, token: string) {
  return `cp:${accountId}:${token}`;
}

export function parseCardplatformRequestId(requestId: string) {
  const match = /^cp:(\d+):(.+)$/.exec(requestId.trim());
  if (!match) return null;
  return { accountId: Number(match[1]), token: match[2]! };
}
