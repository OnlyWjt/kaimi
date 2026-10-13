import { agentOrderStatus } from "./agent-orders-core";

/** 付款后超过这么久还没发齐才提醒，正常发卡几秒就完，别把正在发的单当成异常。 */
export const AGENT_ISSUE_ALERT_AFTER_MS = 10 * 60 * 1000;
/** 太久以前的单不再补提醒：上线这个功能时不把历史异常单一股脑推给代理。 */
export const AGENT_ISSUE_ALERT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function formatAgentIssueAlertText(order: {
  orderNo: string;
  productName: string;
  quantity: number;
  customerEmail: string;
  payStatus: string;
  fulfillStatus: string;
}) {
  const status = agentOrderStatus(order.payStatus, order.fulfillStatus);
  return [
    `订单需要留意：${status.label}`,
    `订单号 ${order.orderNo}`,
    `${order.productName}${order.quantity > 1 ? ` ×${order.quantity}` : ""}`,
    order.customerEmail ? `买家 ${order.customerEmail}` : "",
    status.hint,
    "可以在代理后台「订单」里查看。",
  ]
    .filter(Boolean)
    .join("\n");
}
