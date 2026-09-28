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
  quantity?: number;
  cardIndex?: number;
  listGoodsCents?: number;
  couponCode?: string;
  couponDiscountCents?: number;
  goodsCents?: number;
  agentCostTotalCents?: number;
  agentFeeCents?: number;
  upstreamCostTotalCents?: number | null;
  platformProfitCents?: number | null;
};

export const SAMPLE_NOTIFY_PAYLOAD: NotifyPayload = {
  orderNo: "TEST-NOTIFY",
  status: "success",
  message: "这是一条测试通知，不是真实兑换。",
  agentName: "测试代理店",
  account: "demo@example.com",
  plan: "Plus",
  quantity: 1,
  listGoodsCents: 15000,
  goodsCents: 15000,
  agentCostTotalCents: 3000,
  agentFeeCents: 500,
  agentEarningCents: 11500,
  upstreamCostTotalCents: 2000,
  platformProfitCents: 1000,
};

const STATUS_TEXT: Record<string, string> = {
  success: "兑换成功",
  skipped: "兑换已跳过",
  failed: "兑换失败",
  unknown: "兑换结果未知",
  alert: "运维告警",
};

function yuanLine(label: string, cents?: number | null) {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return "";
  return `${label}：¥${yuanTextFromCents(cents)}`;
}

function yuanLineAlways(label: string, cents?: number | null) {
  if (cents == null || !Number.isFinite(cents)) return "";
  return `${label}：¥${yuanTextFromCents(cents)}`;
}

export function formatNotifyText(payload: NotifyPayload) {
  const title = STATUS_TEXT[payload.status] || payload.status;
  const quantity = payload.quantity && payload.quantity > 1 ? payload.quantity : 0;
  const plan = payload.plan
    ? quantity
      ? `套餐：${payload.plan}（本单 ${quantity} 张${payload.cardIndex ? `，这是第 ${payload.cardIndex} 张` : ""}）`
      : `套餐：${payload.plan}`
    : "";
  const ledger =
    payload.goodsCents != null
      ? [
          yuanLine("挂牌价", payload.listGoodsCents),
          payload.couponDiscountCents
            ? `优惠券：${payload.couponCode || "已使用"}  -¥${yuanTextFromCents(payload.couponDiscountCents)}`
            : "",
          yuanLineAlways("实付商品额", payload.goodsCents),
          yuanLineAlways("代理成本", payload.agentCostTotalCents),
          payload.agentEarningCents == null
            ? ""
            : `代理收益：¥${yuanTextFromCents(payload.agentEarningCents)}（已扣手续费 ¥${yuanTextFromCents(payload.agentFeeCents || 0)}）`,
          payload.platformProfitCents == null
            ? ""
            : `平台毛利：¥${yuanTextFromCents(payload.platformProfitCents)}${
                payload.upstreamCostTotalCents == null
                  ? ""
                  : `（上游 ¥${yuanTextFromCents(payload.upstreamCostTotalCents)}）`
              }`,
        ]
      : [
          yuanLine("售价", payload.retailCents),
          yuanLine("本次收益", payload.platformCents),
          yuanLine("代理收益", payload.agentEarningCents),
        ];
  return [
    `[Kaimi] ${title}  ${payload.orderNo}`,
    payload.agentName ? `代理：${payload.agentName}` : "",
    payload.account ? `开通账号：${payload.account}` : "",
    plan,
    ...ledger,
    payload.message || "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type StorePaidInvoice = {
  title: string;
  note: string;
  amountCents: number;
  email: string;
};

export type StorePaidNotifyPayload = {
  orderNo: string;
  agentName?: string;
  buyerEmail?: string;
  amountCents: number;
  paymentChannel?: string;
  productName?: string;
  quantity?: number;
  invoice: StorePaidInvoice | null;
};

export function notifyPaymentChannelLabel(channel?: string) {
  const raw = String(channel || "").trim();
  if (raw === "alipay") return "支付宝";
  if (raw === "wxpay" || raw === "wechat") return "微信";
  return raw;
}

/** Telegram HTML 只认 & < >，用户填的抬头备注先转义再塞进去。 */
export function escapeTelegramHtml(value: string) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function storePaidLines(payload: StorePaidNotifyPayload) {
  const quantity = payload.quantity && payload.quantity > 1 ? ` ×${payload.quantity}` : "";
  const channel = notifyPaymentChannelLabel(payload.paymentChannel);
  const invoice = payload.invoice;
  return [
    `[Kaimi] 订单已支付  ${payload.orderNo}`,
    invoice ? "这单需要开发票" : "",
    payload.agentName ? `代理：${payload.agentName}` : "",
    payload.buyerEmail ? `购买人：${payload.buyerEmail}` : "",
    yuanLine("订单金额", payload.amountCents),
    channel ? `支付渠道：${channel}` : "",
    payload.productName ? `商品：${payload.productName}${quantity}` : "",
    invoice ? `抬头：${invoice.title}` : "",
    invoice?.note ? `备注：${invoice.note}` : "",
    invoice ? yuanLine("开票金额", invoice.amountCents) : "",
    invoice?.email ? `收票邮箱：${invoice.email}` : "",
  ].filter(Boolean);
}

export function formatStorePaidText(payload: StorePaidNotifyPayload) {
  return storePaidLines(payload).join("\n");
}

/** Bot API 不能标红，用加粗把开票提醒钉在支付通知里。 */
export function formatStorePaidTelegramHtml(payload: StorePaidNotifyPayload) {
  return storePaidLines(payload)
    .map((line, index) => {
      const escaped = escapeTelegramHtml(line);
      if (index === 0) return `<b>${escaped}</b>`;
      if (line === "这单需要开发票") return `<b>⚠️ ${escaped}</b>`;
      return escaped;
    })
    .join("\n");
}

export function notifyYuanFields(payload: NotifyPayload) {
  const retail = payload.listGoodsCents ?? payload.retailCents ?? payload.goodsCents;
  const platform = payload.platformProfitCents ?? payload.platformCents;
  return {
    retailYuan: retail != null ? yuanTextFromCents(retail) : "",
    platformYuan: platform != null ? yuanTextFromCents(platform) : "",
    agentEarningYuan:
      payload.agentEarningCents != null ? yuanTextFromCents(payload.agentEarningCents) : "",
  };
}
