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
  taxNo?: string;
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
  listGoodsCents?: number;
  couponCode?: string;
  couponDiscountCents?: number;
  goodsCents?: number;
  agentCostTotalCents?: number;
  agentFeeCents?: number;
  agentEarningCents?: number;
  upstreamCostTotalCents?: number | null;
  platformProfitCents?: number | null;
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
    `[Kaimi] 客户下单  ${payload.orderNo}`,
    invoice ? "这单需要开发票" : "",
    payload.agentName ? `代理：${payload.agentName}` : "",
    payload.buyerEmail ? `购买人：${payload.buyerEmail}` : "",
    yuanLine("订单金额", payload.amountCents),
    channel ? `支付渠道：${channel}` : "",
    payload.productName ? `套餐：${payload.productName}${quantity}` : "",
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
    invoice ? `抬头：${invoice.title}` : "",
    invoice?.taxNo ? `税号：${invoice.taxNo}` : "",
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

export type DrawApplyNotifyPayload = {
  kind: "apply" | "remind";
  agentName: string;
  username: string;
  agentId: number;
  shopUrl: string;
  contact: string;
  expectedMonthlyLabel: string;
  note: string;
  paidOrderCount: number;
  recentPaidOrderCount: number;
  appliedAt: string;
  firstAppliedHoursAgo?: number;
  adminUrl: string;
};

function drawApplyLines(payload: DrawApplyNotifyPayload) {
  return [
    payload.kind === "remind"
      ? "[Kaimi] 代理催审批：自助提卡"
      : "[Kaimi] 代理申请开通自助提卡",
    `代理：${payload.agentName}（账号 ${payload.username} · ID ${payload.agentId}）`,
    payload.shopUrl ? `店铺：${payload.shopUrl}` : "",
    `联系方式：${payload.contact}`,
    `预计月用量：${payload.expectedMonthlyLabel}`,
    payload.note ? `说明：${payload.note}` : "",
    `已有商城订单：${payload.paidOrderCount} 单 · 近 30 天 ${payload.recentPaidOrderCount} 单`,
    `申请时间：${payload.appliedAt}`,
    payload.kind === "remind" && payload.firstAppliedHoursAgo != null
      ? `首次申请：${payload.firstAppliedHoursAgo} 小时前`
      : "",
    payload.adminUrl ? `去审批：${payload.adminUrl}` : "",
  ].filter(Boolean);
}

export function formatDrawApplyText(payload: DrawApplyNotifyPayload) {
  return drawApplyLines(payload).join("\n");
}

export function formatDrawApplyTelegramHtml(payload: DrawApplyNotifyPayload) {
  return drawApplyLines(payload)
    .map((line, index) => {
      const escaped = escapeTelegramHtml(line);
      return index === 0 ? `<b>${escaped}</b>` : escaped;
    })
    .join("\n");
}

export type DrawCreatedNotifyPayload = {
  drawNo: string;
  agentName: string;
  planName: string;
  quantity: number;
  issuedCount: number;
  unitPriceCents: number;
  amountCents: number;
  exposureCents: number;
  limitCents: number;
  upstreamCostUnitCents: number | null;
};

function drawCreatedLines(payload: DrawCreatedNotifyPayload) {
  const partial = payload.issuedCount < payload.quantity;
  const ratio =
    payload.limitCents > 0 ? Math.round((payload.exposureCents / payload.limitCents) * 100) : 0;
  const profit =
    payload.upstreamCostUnitCents == null
      ? null
      : (payload.unitPriceCents - payload.upstreamCostUnitCents) * payload.issuedCount;
  return [
    `[Kaimi] 代理提卡${partial ? `（部分：${payload.issuedCount}/${payload.quantity}）` : ""}  ${payload.drawNo}`,
    `代理：${payload.agentName}`,
    `套餐：${payload.planName} × ${payload.issuedCount}（单价 ¥${yuanTextFromCents(payload.unitPriceCents)}）`,
    `本次：¥${yuanTextFromCents(payload.amountCents)}`,
    `未结算：¥${yuanTextFromCents(payload.exposureCents)} / 额度 ¥${yuanTextFromCents(payload.limitCents)}（${ratio}%）`,
    profit == null
      ? ""
      : `平台毛利：${profit < 0 ? "-" : ""}¥${yuanTextFromCents(Math.abs(profit))}（上游 ¥${yuanTextFromCents(payload.upstreamCostUnitCents ?? 0)}/张）`,
  ].filter(Boolean);
}

export function formatDrawCreatedText(payload: DrawCreatedNotifyPayload) {
  return drawCreatedLines(payload).join("\n");
}

export function formatDrawCreatedTelegramHtml(payload: DrawCreatedNotifyPayload) {
  return drawCreatedLines(payload)
    .map((line, index) => {
      const escaped = escapeTelegramHtml(line);
      return index === 0 ? `<b>${escaped}</b>` : escaped;
    })
    .join("\n");
}

export type DrawAlertNotifyPayload =
  | {
      kind: "credit_warning";
      agentName: string;
      exposureCents: number;
      limitCents: number;
      adminUrl: string;
    }
  | {
      kind: "recover_failed";
      agentName: string;
      drawNo: string;
      planName: string;
      quantity: number;
      adminUrl: string;
    };

function drawAlertLines(payload: DrawAlertNotifyPayload) {
  if (payload.kind === "credit_warning") {
    const ratio =
      payload.limitCents > 0 ? Math.round((payload.exposureCents / payload.limitCents) * 100) : 100;
    return [
      `[Kaimi] 提卡额度预警：${payload.agentName}`,
      `未结算 ¥${yuanTextFromCents(payload.exposureCents)} / 额度 ¥${yuanTextFromCents(payload.limitCents)}（${ratio}%）`,
      payload.adminUrl ? `去对账：${payload.adminUrl}` : "",
    ].filter(Boolean);
  }
  return [
    `[Kaimi] 提卡结果未知，需人工核对：${payload.drawNo}`,
    `代理：${payload.agentName} · ${payload.planName} × ${payload.quantity}`,
    "卡台可能已扣卡。请到卡台核对后，在后台点「向卡台取回」或「确认没出卡」。",
    payload.adminUrl ? `去处理：${payload.adminUrl}` : "",
  ].filter(Boolean);
}

export function formatDrawAlertText(payload: DrawAlertNotifyPayload) {
  return drawAlertLines(payload).join("\n");
}

export function formatDrawAlertTelegramHtml(payload: DrawAlertNotifyPayload) {
  return drawAlertLines(payload)
    .map((line, index) => {
      const escaped = escapeTelegramHtml(line);
      return index === 0 ? `<b>⚠️ ${escaped}</b>` : escaped;
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
