/**
 * 代理订单页的分组和状态文案。纯函数，前后端共用。
 *
 * 分组按「代理要不要管」来分，不照搬两个状态字段：
 * 付了款还没发齐的单统一算「待处理」，代理最需要盯的就是这一组。
 */

export const AGENT_ORDER_VIEWS = ["all", "attention", "done", "unpaid", "closed", "refund"] as const;
export type AgentOrderView = (typeof AGENT_ORDER_VIEWS)[number];

export const UNPAID_PAY_STATUSES = ["unpaid", "pending_pay"] as const;
export const REFUND_PAY_STATUSES = ["refunding", "refunded", "chargeback"] as const;
/** 付了款、卡还没发齐的发货状态。 */
export const ATTENTION_FULFILL_STATUSES = [
  "pending",
  "issuing",
  "partially_delivered",
  "paid_undelivered",
  "failed",
  "unknown",
] as const;

export function parseAgentOrderView(value: string | null | undefined): AgentOrderView {
  const key = String(value || "").trim();
  return (AGENT_ORDER_VIEWS as readonly string[]).includes(key) ? (key as AgentOrderView) : "all";
}

export type AgentOrderTone = "ok" | "wait" | "bad" | "muted";

/** 给代理看的一句话状态和处理建议。 */
export function agentOrderStatus(payStatus: string, fulfillStatus: string): {
  label: string;
  tone: AgentOrderTone;
  hint: string;
} {
  if ((UNPAID_PAY_STATUSES as readonly string[]).includes(payStatus)) {
    return { label: "待付款", tone: "muted", hint: "买家还没付款，30 分钟不付会自动关闭" };
  }
  if (payStatus === "closed") return { label: "已关闭", tone: "muted", hint: "超时未付款，已自动关闭" };
  if (payStatus === "refunding") return { label: "退款中", tone: "wait", hint: "平台正在处理退款" };
  if (payStatus === "refunded") return { label: "已退款", tone: "muted", hint: "" };
  if (payStatus === "chargeback") return { label: "已拒付", tone: "bad", hint: "买家发起了拒付，请联系平台" };
  if (payStatus !== "paid" && payStatus !== "manual") return { label: payStatus || "未知", tone: "muted", hint: "" };
  switch (fulfillStatus) {
    case "delivered":
      return { label: "已发货", tone: "ok", hint: "" };
    case "pending":
    case "issuing":
      return { label: "发货中", tone: "wait", hint: "一般几秒内发完，超过 10 分钟还没好请联系平台" };
    case "partially_delivered":
      return { label: "部分发货", tone: "wait", hint: "已发出一部分，剩下的系统会自动补发" };
    case "paid_undelivered":
      return { label: "待补货", tone: "bad", hint: "已付款但暂时没货，补货后自动发；可先告诉买家稍等" };
    case "unknown":
      return { label: "发货待核实", tone: "bad", hint: "发卡结果不明，平台会人工核对后补发，请勿让买家重复下单" };
    case "failed":
      return { label: "发货失败", tone: "bad", hint: "平台会处理，请联系平台" };
    case "refunded":
      return { label: "已退款", tone: "muted", hint: "" };
    default:
      return { label: fulfillStatus || "处理中", tone: "wait", hint: "" };
  }
}

/**
 * 代理订单列表的开票状态。只给状态，不给抬头和税号。
 * 没申请开票、没付款的不显示；Folio 对接关着、这单也没进过 Folio 时同样不显示，和没接 Folio 时一样。
 */
export function agentInvoiceStatus(
  order: {
    invoiceRequested: boolean;
    payStatus: string;
    folioPushStatus: string;
    invoiceStatus: string;
  },
  folioEnabled: boolean,
): { label: string; tone: AgentOrderTone; hint: string } | null {
  if (!order.invoiceRequested) return null;
  if (order.invoiceStatus === "reddened") return { label: "已作废", tone: "muted", hint: "" };
  if (order.invoiceStatus === "issued") return { label: "已开票", tone: "ok", hint: "" };
  // 退款前没开出来的票 Folio 会作废，代理这边就不再显示
  if (order.payStatus !== "paid" && order.payStatus !== "manual") return null;
  if (!folioEnabled && !order.folioPushStatus && !order.invoiceStatus) return null;
  if (order.folioPushStatus === "rejected" || order.folioPushStatus === "failed") {
    return { label: "开票异常", tone: "bad", hint: "请联系平台" };
  }
  if (order.folioPushStatus === "pushed") return { label: "开票中", tone: "wait", hint: "" };
  return { label: "待开票", tone: "wait", hint: "" };
}

/** 订单号或邮箱搜索：带 @ 当邮箱精确匹配，否则按订单号包含匹配。去掉 LIKE 通配符。 */
export function parseAgentOrderKeyword(value: string | null | undefined) {
  const text = String(value || "").trim().replace(/[%_]/g, "").slice(0, 254);
  if (!text) return null;
  if (text.includes("@")) return { kind: "email" as const, value: text.toLowerCase() };
  return { kind: "orderNo" as const, value: text.toUpperCase() };
}
