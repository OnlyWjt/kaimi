export const ORDER_TERMINAL_STATUSES = new Set([
  "success",
  "failed",
  "skipped",
  "unknown",
  "fulfilled",
]);

export const ORDER_PIPELINE_STEPS = [
  "pending",
  "issuing",
  "preparing",
  "submitted",
  "processing",
] as const;

export function isOrderTerminalStatus(status: string) {
  return ORDER_TERMINAL_STATUSES.has(status);
}

/**
 * 这一单还要不要再去卡台核一遍。
 *
 * unknown 在 ORDER_TERMINAL_STATUSES 里是对的——界面不给重试入口——但它不是「查完了」：
 * 卡台可能还挂在 review，只有接着查才会变成真终态。所以进度刷新不能直接用
 * isOrderTerminalStatus。
 */
export function shouldRepollOrderStatus(status: string) {
  return status === "unknown" || !isOrderTerminalStatus(status);
}

export function normalizeOrderStatus(status: string) {
  if (status === "running") return "processing";
  return status;
}

export function pipelineStepIndex(status: string) {
  const s = normalizeOrderStatus(status);
  if (isOrderTerminalStatus(s)) return ORDER_PIPELINE_STEPS.length;
  const i = ORDER_PIPELINE_STEPS.indexOf(s as (typeof ORDER_PIPELINE_STEPS)[number]);
  return i >= 0 ? i : 0;
}
