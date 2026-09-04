import type { ItemStatus } from "@/lib/recharge-types";
// 相对路径：这个模块要能在没有 `@/` 别名的单元测试里直接 import。
import { resultOrderStatus } from "../redeem-timeline-core";

/**
 * 卡台状态 → 本站 fulfill_status。
 *
 * 权威状态在 `order.status`：`GET /cdk/result` 把订单字段包在 `order` 里，这里以前
 * 只看顶层，所以嵌套返回体一律读成空串，最后落到 `pending` —— 已经 completed 或
 * declined 的单会一直挂在「处理中」，卡密也永远退不回去。
 *
 * `review` / `pending` 是「支付结果待对账」，卡台文档明确写了不得重试。这里映射成
 * 非终态的 processing：界面上没有重试入口，服务端也会接着轮询，直到卡台给出终态。
 */
export function mapCardplatformStatus(
  payload: Record<string, unknown>,
  responseOk: boolean,
): ItemStatus {
  const raw = resultOrderStatus(payload);
  if (["success", "completed", "fulfilled"].includes(raw)) return "success";
  if (raw === "skipped") return "skipped";
  if (["failed", "error", "cancelled", "declined", "failed_precharge"].includes(raw)) {
    return "failed";
  }
  if (["expired", "canceled", "unknown"].includes(raw)) return "unknown";
  if (["processing", "running", "submitted", "review"].includes(raw)) {
    return "processing";
  }
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
