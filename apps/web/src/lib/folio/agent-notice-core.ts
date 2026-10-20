/**
 * 发给代理的开票通知文案。纯函数。
 *
 * 有意不写抬头、税号、发票号码、PDF 链接和金额：代理看不到买家的开票资料，
 * 下单通知里也只写「这单买家要发票」，这里沿用。要放开哪一项改这里即可。
 */
import { escapeTelegramHtml } from "@/lib/notify-core";
import type { FolioNoticeKind } from "@/lib/folio/core";

export const RED_REASON_LABEL: Record<string, string> = {
  "01": "开票有误",
  "02": "销货退回",
  "03": "服务中止",
  "04": "销售折让",
};

export type AgentInvoiceNotice = {
  kind: FolioNoticeKind;
  orderNo: string;
  productName: string;
  quantity: number;
  /** Folio 回调的 kprq，YYYY-MM-DD HH:MM:SS */
  issuedAt: string;
  email: string;
  /** Folio 回调的 email_status；skipped 表示没发邮件 */
  emailStatus: string;
  redReasonCode: string;
};

/** 保留前 2 位和域名：ab***@qq.com */
export function maskInvoiceEmail(email: string) {
  const value = email.trim();
  const at = value.lastIndexOf("@");
  if (at <= 0) return value ? "***" : "";
  const local = value.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length - 1) || 1)}***${value.slice(at)}`;
}

/** subject 为空时说「已发送到…」，否则说「{subject}已发送到…」。 */
function deliveryLine(notice: AgentInvoiceNotice, subject: string) {
  if (notice.emailStatus === "skipped") {
    return `${subject || "这张发票"}没有发邮件，买家需要可以联系平台`;
  }
  const masked = maskInvoiceEmail(notice.email);
  return masked ? `${subject}已发送到买家收票邮箱 ${masked}` : "";
}

function noticeLines(notice: AgentInvoiceNotice) {
  const head = [`订单：${notice.orderNo}`, `商品：${notice.productName} × ${notice.quantity || 1}`];
  if (notice.kind === "reddened") {
    const reason = RED_REASON_LABEL[notice.redReasonCode] || notice.redReasonCode;
    return ["🧾 发票已作废（红冲）", ...head, reason ? `原因：${reason}` : ""];
  }
  if (notice.kind === "reissued") {
    return ["🧾 发票已重新开具", ...head, deliveryLine(notice, "原发票已作废，新发票")];
  }
  return [
    "🧾 发票已开具",
    ...head,
    notice.issuedAt ? `开票时间：${notice.issuedAt.slice(0, 16)}` : "",
    deliveryLine(notice, ""),
  ];
}

export function formatAgentInvoiceNoticeText(notice: AgentInvoiceNotice) {
  return noticeLines(notice).filter(Boolean).join("\n");
}

export function formatAgentInvoiceNoticeHtml(notice: AgentInvoiceNotice) {
  return noticeLines(notice)
    .filter(Boolean)
    .map((line, index) => {
      const escaped = escapeTelegramHtml(line);
      return index === 0 ? `<b>${escaped}</b>` : escaped;
    })
    .join("\n");
}
