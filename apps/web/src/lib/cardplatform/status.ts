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

/**
 * 兑换请求已经发出去之后的定性。只有上游给出结构化终态、或明确的 4xx 拒收，才敢说失败。
 *
 * publicCdkRequest 只在传输层出错或返回体解析不出来时抛异常；带合法 JSON 的非 2xx 是
 * 正常返回的 `ok:false`，mapCardplatformStatus 最后一行会把它读成 failed。同源代理自己
 * 传输失败时回的就是 502 `{"error": ...}`，那种情况兑换很可能已经转发给卡台、卡也扣过费，
 * 判成 failed 会把卡退回可售并给客户一个重试按钮，等于让人被扣两次。
 */
export function redeemOutcomeStatus(redeemed: {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}): ItemStatus {
  const mapped = mapCardplatformStatus(redeemed.payload, redeemed.ok);
  if (mapped !== "failed") return mapped;
  // 把响应当成 200 重算一遍还是 failed，说明这个 failed 来自上游自己的 order.status
  // （declined / failed_precharge / cancelled …）。那是结构化结论，与 HTTP 码无关，可以照信。
  if (mapCardplatformStatus(redeemed.payload, true) === "failed") return "failed";
  // 剩下的 failed 全是 responseOk=false 推出来的。只有 4xx 算上游明确拒收；
  // 408 / 429 和所有 5xx 都可能是请求已经落到卡台了，一律 unknown。
  const http = redeemed.status;
  return http >= 400 && http < 500 && http !== 408 && http !== 429
    ? "failed"
    : "unknown";
}

export function requestIdForRedeem(accountId: number, token: string) {
  return `cp:${accountId}:${token}`;
}

export function parseCardplatformRequestId(requestId: string) {
  const match = /^cp:(\d+):(.+)$/.exec(requestId.trim());
  if (!match) return null;
  return { accountId: Number(match[1]), token: match[2]! };
}
