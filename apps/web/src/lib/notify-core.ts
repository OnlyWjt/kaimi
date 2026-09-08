import { yuanTextFromCents } from "./money";

export type NotifyPayload = {
  orderNo: string;
  status: string;
  message: string;
  requestId?: string | null;
  plan?: string;
  agentName?: string;
  account?: string;
  retailCents?: number;
  platformCents?: number;
  agentEarningCents?: number;
};

export const SAMPLE_NOTIFY_PAYLOAD: NotifyPayload = {
  orderNo: "TEST-NOTIFY",
  status: "success",
  message: "这是一条测试通知，不是真实兑换。",
  agentName: "测试代理店",
  account: "demo@example.com",
  plan: "Plus",
  retailCents: 15000,
  platformCents: 3000,
  agentEarningCents: 11500,
};

const STATUS_TEXT: Record<string, string> = {
  success: "兑换成功",
  skipped: "兑换已跳过",
  failed: "兑换失败",
  unknown: "兑换结果未知",
  alert: "运维告警",
};

function yuanLine(label: string, cents?: number) {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return "";
  return `${label}：¥${yuanTextFromCents(cents)}`;
}

export function formatNotifyText(payload: NotifyPayload) {
  const title = STATUS_TEXT[payload.status] || payload.status;
  return [
    `[Kaimi] ${title}  ${payload.orderNo}`,
    payload.agentName ? `代理：${payload.agentName}` : "",
    payload.account ? `开通账号：${payload.account}` : "",
    payload.plan ? `套餐：${payload.plan}` : "",
    yuanLine("售价", payload.retailCents),
    yuanLine("本次收益", payload.platformCents),
    yuanLine("代理收益", payload.agentEarningCents),
    payload.message || "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function notifyYuanFields(payload: NotifyPayload) {
  return {
    retailYuan: payload.retailCents != null ? yuanTextFromCents(payload.retailCents) : "",
    platformYuan: payload.platformCents != null ? yuanTextFromCents(payload.platformCents) : "",
    agentEarningYuan:
      payload.agentEarningCents != null ? yuanTextFromCents(payload.agentEarningCents) : "",
  };
}
