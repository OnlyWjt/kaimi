"use client";

import { Fragment, useEffect, useState } from "react";
import { KmSelect } from "@/components/km-select";
import { StoreOrderDetail } from "@/components/store-order-detail";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { hasNextPage, pageLabel } from "@/lib/pagination-core";
import { adminStatusLabel } from "@/lib/status-labels";
import {
  STORE_ORDER_FULFILL_FILTERS,
  STORE_ORDER_PAY_FILTERS,
} from "@/lib/store-order-query-core";

type AgentOption = { id: number; displayName: string };
type StoreOrder = {
  id: number;
  orderNo: string;
  agentName: string;
  productName: string;
  quantity: number;
  retailPriceCents: number;
  grossCents: number;
  issuedCount: number;
  payStatus: string;
  fulfillStatus: string;
  feeReconcileStatus: string;
  lastErrorMessage: string;
  invoiceRequested?: boolean;
  invoiceTitle?: string;
  invoiceTaxNo?: string;
  invoiceNote?: string;
  invoiceEmail?: string;
  invoiceAmountCents?: number;
  invoiceNotifyStatus?: string;
  invoiceNotifyError?: string;
  couponCodeSnapshot?: string;
  couponDiscountCents?: number;
};

const PAGE_SIZE = 20;

const EMPTY_FILTERS = {
  q: "",
  agentId: "",
  payStatus: "",
  fulfillStatus: "",
  invoiceOnly: "",
};

type Filters = typeof EMPTY_FILTERS;

function invoiceNotifyLabel(status?: string) {
  if (status === "sent") return "通知已推送";
  if (status === "failed") return "通知失败";
  if (status === "unsent") return "未配置通知";
  return "待推送";
}

function storeOrderQuery(page: number, filters: Filters) {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (filters.q.trim()) qs.set("q", filters.q.trim());
  if (filters.agentId) qs.set("agentId", filters.agentId);
  if (filters.payStatus) qs.set("payStatus", filters.payStatus);
  if (filters.fulfillStatus) qs.set("fulfillStatus", filters.fulfillStatus);
  if (filters.invoiceOnly) qs.set("invoiceOnly", filters.invoiceOnly);
  return qs;
}

/**
 * 店铺订单的完整操作台：筛选、补发、人工核对、手续费、开票通知、退款。
 * 原来在「即时发卡」里，和「订单」页的店铺订单是同一批数据，现在只留这一处。
 */
export function AdminStoreOrders() {
  const { ask, dialog } = useAskDialog();
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [expandedNo, setExpandedNo] = useState("");

  async function load(nextPage = page, nextFilters = filters) {
    const response = await fetch(`/api/admin/store-orders?${storeOrderQuery(nextPage, nextFilters)}`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.error || "订单加载失败", "err");
      return;
    }
    setOrders(data.list || []);
    setTotal(Number(data.total) || 0);
    setPage(Number(data.page) || nextPage);
  }

  useEffect(() => {
    void load(1, EMPTY_FILTERS);
    void fetch("/api/admin/agents", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { list: [] }))
      .then((data) => setAgents(data.list || []))
      .catch(() => setAgents([]));
    // 只在挂载时拉一次，之后靠筛选和翻页按钮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(url: string, body?: unknown, method: "POST" | "PATCH" = "POST") {
    setBusy(true);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "操作失败");
      return data;
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", "err");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function applyFilters(next: Filters) {
    setDraft(next);
    setFilters(next);
    await load(1, next);
  }

  async function orderAction(order: StoreOrder, action: "retry" | "fee" | "recovery" | "invoice") {
    const suffix =
      action === "retry"
        ? "retry-fulfillment"
        : action === "fee"
          ? "reconcile-fee"
          : action === "invoice"
            ? "invoice-notify"
            : "recovery-link";
    const data = await submit(`/api/admin/store-orders/${encodeURIComponent(order.orderNo)}/${suffix}`);
    if (!data) return;
    if (data.recoveryUrl) {
      try {
        await copyText(data.recoveryUrl);
        toast(`已复制 ${order.orderNo} 的查单链接`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "复制失败，请手动复制", "err");
      }
      return;
    }
    if (action === "invoice") {
      toast(
        data.ok ? "开票通知已推送" : data.invoiceNotifyError || "通知没发出去，订单里仍可查看开票信息",
        data.ok ? undefined : "err",
      );
    } else {
      toast("已提交");
    }
    await load();
  }

  async function resolveUnknown(order: StoreOrder) {
    const choice = await ask({
      title: `处理未知状态订单 ${order.orderNo}`,
      message: "先去卡台核对这笔到底有没有生成卡密，再选对应的处理方式。",
      actions: [
        { name: "issued", label: "已生成，补录卡密" },
        { name: "not_issued", label: "确认未发码", danger: true },
      ],
    });
    if (!choice) return;
    if (choice.__action === "issued") {
      const answer = await ask({
        title: "补录卡密",
        message: `订单 ${order.orderNo}`,
        fields: [{ name: "code", label: "从卡台核对到的完整卡密", required: true }],
        confirmLabel: "补录",
      });
      if (!answer) return;
      const data = await submit(
        `/api/admin/store-orders/${encodeURIComponent(order.orderNo)}/resolve`,
        { action: "confirm_issued", code: answer.code },
        "PATCH",
      );
      if (data) await load();
      return;
    }
    const answer = await ask({
      title: "确认卡台未发码",
      message: "确认后这笔会按未发货处理。",
      fields: [
        {
          name: "confirmation",
          label: "输入完整订单号确认",
          placeholder: order.orderNo,
          mustEqual: order.orderNo,
          required: true,
        },
      ],
      confirmLabel: "确认未发码",
      danger: true,
    });
    if (!answer) return;
    const data = await submit(
      `/api/admin/store-orders/${encodeURIComponent(order.orderNo)}/resolve`,
      { action: "confirm_not_issued", confirmation: answer.confirmation },
      "PATCH",
    );
    if (data) await load();
  }

  async function sendRefund(orderNo: string, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/store-orders/${encodeURIComponent(orderNo)}/refund`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      return {
        ok: response.ok,
        error: typeof data.error === "string" ? data.error : "登记失败",
        code: data.code as string | undefined,
        redeemedCount: data.redeemedCount as number | undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "登记失败",
        code: undefined,
        redeemedCount: undefined,
      };
    } finally {
      setBusy(false);
    }
  }

  async function recordRefund(order: StoreOrder) {
    const choice = await ask({
      title: `登记退款 / 拒付 ${order.orderNo}`,
      message: "拒付是支付渠道强制扣回，普通退款是你主动退给买家。",
      actions: [
        { name: "refund", label: "普通退款" },
        { name: "chargeback", label: "拒付", danger: true },
      ],
    });
    if (!choice) return;
    const chargeback = choice.__action === "chargeback";
    const answer = await ask({
      title: chargeback ? "登记拒付" : "登记退款",
      message: "会禁用这笔未使用的卡密并冲正代理收益，登记后不能撤销。",
      fields: [
        { name: "reference", label: "支付渠道退款/拒付参考号", required: true },
        { name: "reason", label: "原因", required: true },
        {
          name: "confirmation",
          label: "输入完整订单号确认",
          placeholder: order.orderNo,
          mustEqual: order.orderNo,
          required: true,
        },
      ],
      confirmLabel: "确认登记",
      danger: true,
    });
    if (!answer) return;
    const body = {
      type: choice.__action,
      reference: answer.reference,
      reason: answer.reason,
      confirmation: answer.confirmation,
    };
    let result = await sendRefund(order.orderNo, body);
    if (result.code === "CDK_REDEEMED") {
      const accepted = await ask({
        title: "卡密已被兑换",
        message: `这笔订单有 ${result.redeemedCount ?? 1} 张卡台卡密已被买家兑换，卡台无法退卡。\n继续登记只会把订单标记为${chargeback ? "拒付" : "退款"}并冲正代理收益，卡密成本由平台承担。`,
        acknowledge: "卡台卡密已被兑换，无法退卡，平台承担成本",
        confirmLabel: "继续登记",
        danger: true,
      });
      if (!accepted) {
        toast("已取消登记");
        return;
      }
      result = await sendRefund(order.orderNo, { ...body, acceptRedeemed: true });
    }
    if (!result.ok) {
      await ask({ title: "登记失败", message: result.error, confirmLabel: "知道了" });
      return;
    }
    toast(`${order.orderNo} 已登记${chargeback ? "拒付" : "退款"}`);
    await load();
  }

  return (
    <div className="space-y-3">
      {dialog}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void applyFilters(draft);
        }}
      >
        <label className="block space-y-1 text-sm">
          <span>关键字</span>
          <input
            className="km-input w-56"
            placeholder="订单号 / 代理 / 套餐 / 抬头 / 邮箱"
            value={draft.q}
            onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>代理</span>
          <KmSelect
            className="w-40"
            value={draft.agentId}
            placeholder="全部代理"
            options={[
              { value: "", label: "全部代理" },
              ...agents.map((agent) => ({ value: String(agent.id), label: agent.displayName })),
            ]}
            onChange={(value) => setDraft((current) => ({ ...current, agentId: value }))}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>支付</span>
          <KmSelect
            className="w-36"
            value={draft.payStatus}
            placeholder="全部支付"
            options={[
              { value: "", label: "全部支付" },
              ...STORE_ORDER_PAY_FILTERS.map((item) => ({ value: item, label: adminStatusLabel(item, "pay") })),
            ]}
            onChange={(value) => setDraft((current) => ({ ...current, payStatus: value }))}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>发卡</span>
          <KmSelect
            className="w-36"
            value={draft.fulfillStatus}
            placeholder="全部发卡"
            options={[
              { value: "", label: "全部发卡" },
              ...STORE_ORDER_FULFILL_FILTERS.map((item) => ({
                value: item,
                label: adminStatusLabel(item, "fulfill"),
              })),
            ]}
            onChange={(value) => setDraft((current) => ({ ...current, fulfillStatus: value }))}
          />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={draft.invoiceOnly === "1"}
            onChange={(event) =>
              setDraft((current) => ({ ...current, invoiceOnly: event.target.checked ? "1" : "" }))
            }
          />
          <span>只看开票</span>
        </label>
        <button type="submit" className="km-btn" disabled={busy}>
          筛选
        </button>
        <button
          type="button"
          className="km-btn km-btn-ghost"
          disabled={busy}
          onClick={() => void applyFilters(EMPTY_FILTERS)}
        >
          清空
        </button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-[var(--km-fg-muted)]">{pageLabel(total, page, PAGE_SIZE)}</span>
        <div className="flex gap-2">
          <button
            type="button"
            className="km-btn km-btn-ghost"
            disabled={busy || page <= 1}
            onClick={() => void load(Math.max(1, page - 1))}
          >
            上一页
          </button>
          <button
            type="button"
            className="km-btn km-btn-ghost"
            disabled={busy || !hasNextPage(total, page, PAGE_SIZE)}
            onClick={() => void load(page + 1)}
          >
            下一页
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="km-table min-w-[960px]">
          <colgroup>
            <col style={{ width: "20%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "16%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>订单</th>
              <th>代理 / 套餐</th>
              <th>金额</th>
              <th>支付</th>
              <th>发卡</th>
              <th>手续费</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const quantity = order.quantity || 1;
              const expanded = expandedNo === order.orderNo;
              return (
                <Fragment key={order.id}>
                  <tr>
                    <td className="font-mono">
                      <div className="km-clip" title={order.orderNo}>
                        {order.orderNo}
                      </div>
                      {order.invoiceRequested ? (
                        <div className="text-xs text-[var(--km-fg-muted)]">
                          开票 · {invoiceNotifyLabel(order.invoiceNotifyStatus)}
                          {order.invoiceNotifyError ? `：${order.invoiceNotifyError}` : ""}
                        </div>
                      ) : null}
                    </td>
                    <td className="km-clip" title={`${order.agentName} · ${order.productName}`}>
                      {order.agentName} · {order.productName}
                    </td>
                    <td>
                      {/* gross_cents 是 NOT NULL DEFAULT 0，老单回填失败时是 0，用单价兜底。 */}¥
                      {((order.grossCents || order.retailPriceCents * quantity) / 100).toFixed(2)}
                      {quantity > 1 ? <span className="km-badge ml-2">×{quantity}</span> : null}
                      {order.invoiceRequested ? (
                        <div className="mt-1 space-y-0.5 text-xs text-[var(--km-fg-muted)]">
                          <div>
                            开票 ¥{((order.invoiceAmountCents || order.grossCents) / 100).toFixed(2)}
                            {order.invoiceTitle ? ` · ${order.invoiceTitle}` : ""}
                          </div>
                          {order.invoiceTaxNo ? <div>税号 {order.invoiceTaxNo}</div> : null}
                          {order.invoiceNote ? <div>备注 {order.invoiceNote}</div> : null}
                          {order.invoiceEmail ? <div>邮箱 {order.invoiceEmail}</div> : null}
                        </div>
                      ) : null}
                      {(order.couponDiscountCents || 0) > 0 ? (
                        <div className="mt-1 text-xs text-[var(--km-fg-muted)]">
                          券 {order.couponCodeSnapshot || ""} −¥{((order.couponDiscountCents || 0) / 100).toFixed(2)}
                        </div>
                      ) : null}
                    </td>
                    <td>{adminStatusLabel(order.payStatus, "pay")}</td>
                    <td title={order.lastErrorMessage}>
                      {adminStatusLabel(order.fulfillStatus, "fulfill")}
                      {quantity > 1 ? (
                        <div className="text-xs text-[var(--km-fg-muted)]">
                          已出 {order.issuedCount ?? 0}/{quantity}
                        </div>
                      ) : null}
                    </td>
                    <td>{adminStatusLabel(order.feeReconcileStatus, "fee")}</td>
                    <td>
                      <div className="km-row-actions">
                        {order.payStatus === "paid" &&
                        ["paid_undelivered", "partially_delivered", "issuing"].includes(order.fulfillStatus) ? (
                          <button
                            className="km-btn km-btn-ghost"
                            disabled={busy}
                            onClick={() => void orderAction(order, "retry")}
                          >
                            {order.fulfillStatus === "issuing"
                              ? "恢复发卡"
                              : order.fulfillStatus === "partially_delivered"
                                ? "补发剩余"
                                : "重试发卡"}
                          </button>
                        ) : null}
                        {order.fulfillStatus === "unknown" ? (
                          <button
                            className="km-btn km-btn-ghost"
                            disabled={busy}
                            onClick={() => void resolveUnknown(order)}
                          >
                            人工核对
                          </button>
                        ) : null}
                        <button
                          className="km-btn km-btn-ghost"
                          onClick={() => setExpandedNo(expanded ? "" : order.orderNo)}
                        >
                          {expanded ? "收起" : "明细"}
                        </button>
                        <details className="km-more">
                          <summary className="km-btn km-btn-ghost">更多</summary>
                          <div className="km-more-menu">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void orderAction(order, "recovery")}
                            >
                              复制查单链接
                            </button>
                            {order.payStatus === "paid" &&
                            !["confirmed", "unsupported"].includes(order.feeReconcileStatus) ? (
                              <button type="button" disabled={busy} onClick={() => void orderAction(order, "fee")}>
                                重对手续费
                              </button>
                            ) : null}
                            {order.invoiceRequested && order.payStatus === "paid" ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void orderAction(order, "invoice")}
                              >
                                {order.invoiceNotifyStatus === "sent" ? "再推开票通知" : "补推开票通知"}
                              </button>
                            ) : null}
                            {order.payStatus === "paid" ? (
                              <button
                                type="button"
                                className="text-[var(--km-danger)]"
                                disabled={busy}
                                onClick={() => void recordRefund(order)}
                              >
                                登记退款 / 拒付
                              </button>
                            ) : null}
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td colSpan={7}>
                        <StoreOrderDetail orderNo={order.orderNo} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!orders.length ? (
          <p className="py-8 text-center text-sm text-[var(--km-fg-muted)]">没有符合条件的订单</p>
        ) : null}
      </div>
    </div>
  );
}
