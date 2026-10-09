import { randomUUID } from "node:crypto";

/**
 * 发卡租约 token。schema 里没有专门的 owner 列，占用期间借 lastErrorCode 存放
 * `LEASE:<uuid>`：updatedAt 会被邮件、通知、对账等范围外代码无条件改写，不能当版本号；
 * lastErrorCode 在 issuing 期间只有发卡 worker 和管理员有意抢占（退款/人工处理）会写。
 * 后续写入都带 `lastErrorCode = token` 条件，影响 0 行就说明租约已经丢了，必须放弃。
 */
export const LEASE_PREFIX = "LEASE:";

export function newLeaseToken(): string {
  return `${LEASE_PREFIX}${randomUUID()}`;
}

export function isLeaseToken(code: string | null | undefined): boolean {
  return typeof code === "string" && code.startsWith(LEASE_PREFIX) && code.length > LEASE_PREFIX.length;
}

/** 本地写库冲突：上游已经出卡，但租约丢失或订单状态变化导致入库失败。 */
export const LOCAL_WRITE_CONFLICT = "LOCAL_WRITE_CONFLICT";

export class LeaseLostError extends Error {
  constructor(message = "发卡租约已失效，已放弃本次写入") {
    super(message);
    this.name = "LeaseLostError";
  }
}

/**
 * 上游出卡后本地写失败时，按上游返回的引用组装可留档的摘要（只留引用和前缀，不含卡密明文）。
 */
export function upstreamRefsSummary(
  items: Array<{ upstreamRef: string; codePrefix: string }>,
): { upstreamRefs: string[]; codePrefixes: string[] } {
  return {
    upstreamRefs: items.map((item) => item.upstreamRef),
    codePrefixes: items.map((item) => item.codePrefix),
  };
}
