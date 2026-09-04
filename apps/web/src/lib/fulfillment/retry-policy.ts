/**
 * 自动补发的退避阶梯和预算。
 *
 * 索引是「真失败过几次」，不是 attempt_no。一次 partial 是进展不是故障：卡台一次只
 * 回一张时，5 张的单会把 attempt 1-5 全用掉，买家要等 60s + 3m + 10m + 30m 才拿到最后
 * 一张，8 次之后还会被强制打成 unknown —— 钱已经全付了，却没有任何东西出错。
 */
export const FULFILLMENT_RETRY_DELAYS_MS = [
  0,
  60_000,
  3 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];

/** 会吃掉重试预算的 attempt 结果。success / partial / running 都不算。 */
export const FULFILLMENT_FAILED_RESULTS = ["failed", "unknown"];

/**
 * 管理员人工核对之后给旧 attempt 打的标记。
 *
 * 不打这个标记的话，confirm_not_issued 把单退回 paid_undelivered 也没用：失败计数还是
 * 满的，下一轮扫描会立刻把它打回 unknown，管理员永远只能一张一张手工补录。
 */
export const FULFILLMENT_ABANDONED_RESULT = "abandoned";

/** 预算用完了吗。只数真失败。 */
export function fulfillmentRetryExhausted(failedAttempts: number) {
  return (
    Math.max(0, Math.trunc(failedAttempts)) >= FULFILLMENT_RETRY_DELAYS_MS.length
  );
}

/** 下一次重试要等多久。同样按真失败次数取，有进展就退回 0。 */
export function fulfillmentRetryDelayMs(failedAttempts: number) {
  const index = Math.max(0, Math.trunc(failedAttempts));
  return (
    FULFILLMENT_RETRY_DELAYS_MS[index] ??
    FULFILLMENT_RETRY_DELAYS_MS[FULFILLMENT_RETRY_DELAYS_MS.length - 1]!
  );
}
