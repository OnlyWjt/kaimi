"use client";

import { useEffect, useState } from "react";
import { StatusBadge, progressLabel } from "@/components/admin-ui";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { formatDateTime, formatLocalMonthDayTime } from "@/lib/datetime";
import { adminStatusLabel } from "@/lib/status-labels";

type Item = { id: number; preview: string };
type Redemption = { orderNo: string; fulfillStatus: string; email: string; createdAt: string };
type InvoiceEvent = {
  id: number;
  event: string;
  version: number;
  applied: boolean;
  noticeKind: string;
  agentNotifyStatus: string;
  agentNotifyError: string;
  createdAt: string;
};
type Invoice = {
  folioEnabled: boolean;
  pushStatus: string;
  pushError: string;
  pushedAt: string | null;
  folioInvoiceId: string;
  status: string;
  invoiceNo: string;
  issuedAt: string | null;
  pdfUrl: string;
  refundAction: string;
  canPush: boolean;
  canResendNotice: boolean;
  events: InvoiceEvent[];
};
type Detail = {
  orderNo: string;
  agent: string;
  email: string;
  plan: string;
  quantity: number;
  grossCents: number;
  payStatus: string;
  fulfillStatus: string;
  channel: string;
  productKind: "finished" | "cdk";
  createdAt: string;
  message: string;
  items: Item[];
  redemptions: Redemption[];
  invoice: Invoice | null;
};

const CHANNEL_LABEL: Record<string, string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
  wechat: "微信支付",
  usdt: "USDT",
};

export function StoreOrderDetail({ orderNo }: { orderNo: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<Record<number, string>>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const response = await fetch(`/api/admin/store-orders/${encodeURIComponent(orderNo)}/detail`, {
          cache: "no-store",
        });
        const data = await response.json();
        if (stopped) return;
        if (!response.ok) throw new Error(data.error || "读取失败");
        setDetail(data);
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : "读取失败");
      }
    })();
    return () => {
      stopped = true;
    };
  }, [orderNo, reloadKey]);

  async function reveal(id: number) {
    const response = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reveal_cdk", id }),
    });
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "查看失败", "err");
      return;
    }
    setShown((current) => ({ ...current, [id]: String(data.code || "") }));
  }

  async function copy(value: string) {
    try {
      await copyText(value);
      toast("已复制");
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  if (error) return <div className="km-od km-od-note text-[var(--km-danger)]">{error}</div>;
  if (!detail) return <div className="km-od km-od-note">读取订单…</div>;
  const finished = detail.productKind === "finished";
  const facts: Array<[string, string]> = [
    ["代理", detail.agent || "—"],
    ["买家邮箱", detail.email || "—"],
    ["商品", `${detail.plan} × ${detail.quantity}`],
    ["金额", `¥${(detail.grossCents / 100).toFixed(2)}`],
    ["支付", `${CHANNEL_LABEL[detail.channel] || detail.channel || "—"} · ${adminStatusLabel(detail.payStatus, "pay")}`],
    ["发卡", progressLabel(finished ? "finished" : "store", detail.fulfillStatus)],
    ["下单时间", formatDateTime(detail.createdAt)],
  ];

  return (
    <div className="km-od">
      <dl className="km-od-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      {detail.message ? <p className="km-od-message">{detail.message}</p> : null}
      <div className={`km-od-grid${finished ? " is-single" : ""}`}>
        <section className="km-od-block">
          <h4>
            {finished ? "交付内容" : "发出的卡密"}
            <span>{detail.items.length}</span>
          </h4>
          {detail.items.length === 0 ? <p className="km-od-empty">还没有交付内容。</p> : null}
          {detail.items.map((item) => {
            const plain = shown[item.id];
            return (
              <div key={item.id} className="km-od-line">
                <code>{plain || item.preview || "—"}</code>
                {plain ? (
                  <button type="button" className="km-od-act" onClick={() => void copy(plain)}>
                    复制
                  </button>
                ) : (
                  <button type="button" className="km-od-act" onClick={() => void reveal(item.id)}>
                    查看
                  </button>
                )}
              </div>
            );
          })}
        </section>
        {finished ? null : (
          <section className="km-od-block">
            <h4>
              兑换记录
              <span>{detail.redemptions.length}</span>
            </h4>
            {detail.redemptions.length === 0 ? <p className="km-od-empty">还没有人拿这张卡去兑换。</p> : null}
            {detail.redemptions.map((row) => (
              <div key={row.orderNo} className="km-od-line">
                <div className="min-w-0">
                  <code>{row.orderNo}</code>
                  <p className="km-od-sub">
                    {row.email || "—"} · {formatDateTime(row.createdAt)}
                  </p>
                </div>
                <StatusBadge status={row.fulfillStatus} />
              </div>
            ))}
          </section>
        )}
      </div>
      {detail.invoice ? (
        <InvoiceBlock
          orderNo={detail.orderNo}
          invoice={detail.invoice}
          onChanged={() => setReloadKey((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}

const PUSH_LABEL: Record<string, string> = {
  pending: "排队推送",
  pushed: "已推送",
  rejected: "被 Folio 拒绝",
  failed: "推送失败",
};

const INVOICE_STATUS_LABEL: Record<string, string> = {
  pending_review: "待开具",
  issued: "已开具",
  reddened: "已作废（红冲）",
};

const REFUND_ACTION_LABEL: Record<string, string> = {
  canceled: "Folio 已作废",
  red_flush: "排队红冲",
  red_pending: "开出后红冲",
  already_reddened: "之前已红冲",
  partial_refund_alert: "待财务处理",
  none: "Folio 没有这张票",
};

const EVENT_LABEL: Record<string, string> = {
  "invoice.issued": "开具",
  "invoice.reddened": "红冲",
  "invoice.file_ready": "PDF 就绪",
  "invoice.resync": "重新同步",
};

const NOTICE_LABEL: Record<string, string> = {
  issued: "已开具",
  reissued: "已重新开具",
  reddened: "已作废",
};

function noticeText(row: InvoiceEvent) {
  if (!row.noticeKind) return row.applied ? "不通知代理" : "旧版本，未回写";
  const kind = NOTICE_LABEL[row.noticeKind] || row.noticeKind;
  if (row.agentNotifyStatus === "sent") return `已通知代理「${kind}」`;
  if (row.agentNotifyStatus === "skipped") return `没发：${row.agentNotifyError || "已跳过"}`;
  if (row.agentNotifyStatus === "failed") return `通知失败：${row.agentNotifyError || "发送失败"}`;
  return "通知排队中";
}

function InvoiceBlock({
  orderNo,
  invoice,
  onChanged,
}: {
  orderNo: string;
  invoice: Invoice;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function act(path: "folio-push" | "invoice-agent-notify") {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/store-orders/${encodeURIComponent(orderNo)}/${path}`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "操作失败");
      if (path === "folio-push") toast("已排队补推，一分钟内推到 Folio");
      else if (data.ok) toast("已补发给代理");
      else toast(data.error || "没发出去", "err");
      onChanged();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "操作失败", "err");
    } finally {
      setBusy(false);
    }
  }

  const push = invoice.pushStatus
    ? PUSH_LABEL[invoice.pushStatus] || invoice.pushStatus
    : invoice.folioEnabled
      ? "未推送"
      : "未推送（对接未开启）";
  const facts: Array<[string, string]> = [
    ["推送 Folio", invoice.pushedAt ? `${push} · ${formatLocalMonthDayTime(invoice.pushedAt)}` : push],
    ["Folio 发票", invoice.folioInvoiceId ? `#${invoice.folioInvoiceId}` : "—"],
    ["发票号码", invoice.invoiceNo || "—"],
    ["开票时间", invoice.issuedAt ? invoice.issuedAt.slice(0, 16) : "—"],
    ...(invoice.refundAction
      ? ([["退款处理", REFUND_ACTION_LABEL[invoice.refundAction] || invoice.refundAction]] as Array<[string, string]>)
      : []),
  ];

  return (
    <section className="km-od-block km-od-invoice">
      <div className="km-od-head">
        <h4>
          开票
          <span>{INVOICE_STATUS_LABEL[invoice.status] || "未开具"}</span>
        </h4>
        <div className="km-od-head-acts">
          {invoice.pdfUrl ? (
            <a className="km-od-act" href={invoice.pdfUrl} target="_blank" rel="noreferrer">
              查看 PDF
            </a>
          ) : null}
          {invoice.canPush ? (
            <button type="button" className="km-od-act" disabled={busy} onClick={() => void act("folio-push")}>
              补推到 Folio
            </button>
          ) : null}
          {invoice.canResendNotice ? (
            <button
              type="button"
              className="km-od-act"
              disabled={busy}
              onClick={() => void act("invoice-agent-notify")}
            >
              补发代理通知
            </button>
          ) : null}
        </div>
      </div>
      <dl className="km-od-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      {invoice.pushError ? <p className="km-od-message">{invoice.pushError}</p> : null}
      {invoice.events.length ? (
        <div className="km-od-events">
          {invoice.events.map((row) => (
            <div key={row.id} className="km-od-line">
              <div className="min-w-0">
                <span className="km-od-ev">
                  {EVENT_LABEL[row.event] || row.event}
                  <span>v{row.version}</span>
                </span>
                <p className="km-od-sub">{formatDateTime(row.createdAt)}</p>
              </div>
              <span className="km-od-sub" title={noticeText(row)}>
                {noticeText(row)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
