"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { type AgentOrderTone, type AgentOrderView } from "@/lib/agent-orders-core";
import { formatDateTime } from "@/lib/datetime";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
import { hasNextPage, pageLabel } from "@/lib/pagination-core";

type AgentOrder = {
  orderNo: string;
  productName: string;
  quantity: number;
  customerEmail: string;
  amountCents: number;
  earningCents: number;
  statusLabel: string;
  statusTone: AgentOrderTone;
  statusHint: string;
  canResendMail: boolean;
  queryUrl: string;
  createdAt: string;
};

const PAGE_SIZE = 20;

const VIEWS: Array<{ value: AgentOrderView; label: string }> = [
  { value: "all", label: "全部" },
  { value: "attention", label: "待处理" },
  { value: "done", label: "已发货" },
  { value: "unpaid", label: "待付款" },
  { value: "closed", label: "已关闭" },
  { value: "refund", label: "退款" },
];

const TONE_CLASS: Record<AgentOrderTone, string> = {
  ok: "",
  wait: " warn",
  bad: " bad",
  muted: " mute",
};

export function AgentOrders() {
  const [orders, setOrders] = useState<AgentOrder[]>([]);
  const [view, setView] = useState<AgentOrderView>("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [attentionCount, setAttentionCount] = useState(0);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), view });
        if (query) qs.set("q", query);
        const data = await readApiJson<{
          list?: AgentOrder[];
          total?: number;
          attentionCount?: number;
        }>(await fetch(`/api/agent/orders?${qs}`, { cache: "no-store" }));
        if (cancelled) return;
        setOrders(data.list || []);
        setTotal(Number(data.total) || 0);
        setAttentionCount(Number(data.attentionCount) || 0);
        setError("");
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "订单加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [page, query, view]);

  function search(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(q.trim());
  }

  async function resendMail(orderNo: string) {
    setResending(orderNo);
    try {
      const data = await readApiJson<{ ok: boolean; message: string }>(
        await fetch(`/api/agent/orders/${encodeURIComponent(orderNo)}/resend-mail`, { method: "POST" }),
      );
      toast(data.message, data.ok ? "ok" : "err");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "重发失败", "err");
    } finally {
      setResending("");
    }
  }

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>订单</h1>
          <p>买家说付了钱没收到卡，先在这里按邮箱或订单号找到这一单，看卡在哪一步。</p>
        </div>
      </header>
      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
      <section className="km-panel space-y-4">
        <div className="km-acp-chips">
          {VIEWS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`km-acp-chip${view === item.value ? " is-on" : ""}`}
              onClick={() => {
                setView(item.value);
                setPage(1);
              }}
            >
              {item.label}
              {item.value === "attention" && attentionCount > 0 ? ` ${attentionCount}` : ""}
            </button>
          ))}
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={search}>
          <input
            className="km-input max-w-xs"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="订单号或买家邮箱"
          />
          <button type="submit" className="km-btn km-btn-ghost">
            搜索
          </button>
        </form>
        <div className="overflow-x-auto">
          <table className="km-acp-price">
            <thead>
              <tr>
                <th>下单时间</th>
                <th>订单号</th>
                <th>商品</th>
                <th>买家邮箱</th>
                <th>实付</th>
                <th>收益</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderNo}>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(order.createdAt)}</td>
                  <td className="font-mono text-xs">{order.orderNo}</td>
                  <td>
                    {order.productName}
                    {order.quantity > 1 ? ` ×${order.quantity}` : ""}
                  </td>
                  <td className="text-xs">{order.customerEmail || "—"}</td>
                  <td>¥{yuanTextFromCents(order.amountCents)}</td>
                  <td>{order.earningCents ? `¥${yuanTextFromCents(order.earningCents)}` : "—"}</td>
                  <td>
                    <span className={`km-acp-pill${TONE_CLASS[order.statusTone]}`} title={order.statusHint}>
                      {order.statusLabel}
                    </span>
                    {order.statusHint && order.statusTone === "bad" ? (
                      <p className="mt-1 max-w-[16rem] text-xs text-[var(--km-fg-muted)]">{order.statusHint}</p>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap">
                    {order.queryUrl ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() =>
                          void navigator.clipboard.writeText(order.queryUrl).then(() => toast("查单链接已复制，发给买家即可"))
                        }
                      >
                        复制查单链接
                      </button>
                    ) : null}
                    {order.canResendMail ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={resending === order.orderNo}
                        onClick={() => void resendMail(order.orderNo)}
                      >
                        {resending === order.orderNo ? "发送中…" : "重发邮件"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!orders.length && !loading ? (
            <p className="py-8 text-center text-sm text-[var(--km-fg-muted)]">
              {query ? "没有匹配的订单" : view === "attention" ? "没有待处理的订单" : "还没有订单"}
            </p>
          ) : null}
        </div>
        {total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--km-border)] pt-3 text-sm">
            <span className="text-[var(--km-fg-muted)]">{pageLabel(total, page, PAGE_SIZE)}</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={!hasNextPage(total, page, PAGE_SIZE)}
                onClick={() => setPage((current) => current + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
