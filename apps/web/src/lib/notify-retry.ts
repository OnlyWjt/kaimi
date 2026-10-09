/** 代理下单通知（Telegram）的重试/占位规则，纯函数便于测试。 */

export const AGENT_NOTIFY_ATTEMPTS = 5;
/** 只重试最近 3 天内付款的订单 */
export const AGENT_NOTIFY_RETRY_MS = 3 * 24 * 60 * 60 * 1000;
/** 两次重试之间至少间隔（基于 updatedAt） */
export const AGENT_NOTIFY_BACKOFF_MS = 60 * 1000;
/** sending 超过这个时间视为发送进程已死，可重新占位 */
export const AGENT_NOTIFY_SENDING_STALE_MS = 2 * 60 * 1000;

/** 可被（非 force）占位发送的状态；skipped/sent 不再处理 */
export const AGENT_NOTIFY_CLAIMABLE = ["", "pending", "failed"] as const;
/** 调度器重试取出的状态 */
export const AGENT_NOTIFY_RETRYABLE = ["pending", "failed"] as const;

export function agentNotifyRetryWindow(nowMs: number) {
  return {
    /** paidAt >= paidSince */
    paidSince: new Date(nowMs - AGENT_NOTIFY_RETRY_MS).toISOString(),
    /** updatedAt < updatedBefore（退避） */
    updatedBefore: new Date(nowMs - AGENT_NOTIFY_BACKOFF_MS).toISOString(),
  };
}

export function agentNotifyStaleBefore(nowMs: number) {
  return new Date(nowMs - AGENT_NOTIFY_SENDING_STALE_MS).toISOString();
}

/**
 * 与 deliverAgentStorePaid 中条件 UPDATE 的 WHERE 语义一致，用于测试和文档。
 */
export function canClaimAgentNotify(
  row: { status: string; attempts: number; updatedAt: string },
  nowMs: number,
  force = false,
) {
  const staleSending = row.status === "sending" && row.updatedAt < agentNotifyStaleBefore(nowMs);
  if (force) return row.status !== "sending" || staleSending;
  if (row.attempts >= AGENT_NOTIFY_ATTEMPTS) return false;
  return (AGENT_NOTIFY_CLAIMABLE as readonly string[]).includes(row.status) || staleSending;
}
