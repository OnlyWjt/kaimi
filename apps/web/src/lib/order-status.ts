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

export function orderStatusLabel(status: string) {
  const map: Record<string, string> = {
    pending: "排队中",
    issuing: "发卡中",
    preparing: "准备中",
    submitted: "已提交",
    processing: "开通处理中",
    success: "已成功",
    failed: "失败",
    skipped: "无需开通",
    unknown: "结果待确认",
    fulfilled: "已完成",
    running: "处理中",
  };
  return map[status] || status;
}

export function isOrderTerminalStatus(status: string) {
  return ORDER_TERMINAL_STATUSES.has(status);
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
