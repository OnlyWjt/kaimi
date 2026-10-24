"use client";

import { PlanLabel } from "@/components/plan-label";
import { FormEvent, useState } from "react";
import { toast } from "@/components/toast";
import type { DrawLookupItem, DrawLookupOrder } from "@/lib/agent-draw-lookup";
import { formatDateTime } from "@/lib/datetime";
import { yuanTextFromCents } from "@/lib/money";
import { adminStatusLabel } from "@/lib/status-labels";

const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  issuing: { label: "出卡中", tone: "wait" },
  delivered: { label: "已出卡", tone: "ok" },
  partial: { label: "部分出卡", tone: "wait" },
  failed: { label: "失败", tone: "bad" },
  unknown: { label: "待确认", tone: "wait" },
};

function settleBadge(item: DrawLookupItem) {
  if (item.status === "void") return { label: "已作废", tone: "", title: item.voidReason };
  if (item.status === "settled") {
    return { label: item.settleRef ? `已结算 · ${item.settleRef}` : "已结算", tone: "ok", title: "" };
  }
  if (item.settleRef && item.settlePending) {
    return { label: `对账中 · ${item.settleRef}`, tone: "wait", title: "已进对账批次，还没登记付款" };
  }
  return { label: "未结算", tone: "wait", title: "" };
}

/** 超管按提卡单号或卡密直接找提卡单：不用先选代理，结没结算都能查到。 */
export function AdminDrawLookup({ onOpenAgent }: { onOpenAgent: (agentId: number) => void }) {
  const [q, setQ] = useState("");
  const [searched, setSearched] = useState("");
  const [orders, setOrders] = useState<DrawLookupOrder[]>([]);
  const [loading, setLoading] = useState(false);

  async function search(event: FormEvent) {
    event.preventDefault();
    const value = q.trim();
    if (value.length < 4) {
      toast("至少输入 4 位", "err");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/draw?lookup=${encodeURIComponent(value)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "查询失败");
      setOrders(data.orders || []);
      setSearched(value);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "查询失败", "err");
    } finally {
      setLoading(false);
    }
  }

  function clear() {
    setQ("");
    setSearched("");
    setOrders([]);
  }

  return (
    <section className="km-panel km-dlk">
      <form className="km-dlk-bar" onSubmit={search}>
        <div className="min-w-0">
          <p className="font-medium">查提卡单</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            输入提卡单号（DR 开头，可以只粘一段）或卡密、成品号邮箱，不用先选代理，结没结算都能查到。
          </p>
        </div>
        <div className="km-dlk-input">
          <input
            className="km-input"
            value={q}
            placeholder="DR2026… 或卡密"
            aria-label="提卡单号或卡密"
            onChange={(event) => setQ(event.target.value)}
          />
          <button type="submit" className="km-btn km-btn-sm" disabled={loading}>
            {loading ? "查询中…" : "查询"}
          </button>
          {searched ? (
            <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={clear}>
              清除
            </button>
          ) : null}
        </div>
      </form>

      {searched && !orders.length ? (
        <p className="km-dlk-empty">没有找到「{searched}」对应的提卡单。卡密要输完整的一串。</p>
      ) : null}

      {orders.map((order) => {
        const state = ORDER_STATUS[order.status] || { label: order.status, tone: "" };
        const who = [order.realName || "未填姓名", order.username ? `@${order.username}` : ""].filter(Boolean).join(" · ");
        return (
          <article key={order.drawNo} className="km-dlk-order">
            <header className="km-dlk-head">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="km-dlk-no">{order.drawNo}</code>
                  <span className={`km-badge ${state.tone ? `km-badge-${state.tone}` : ""}`}>{state.label}</span>
                </div>
                <p className="mt-1 text-xs text-[var(--km-fg-muted)]">
                  <b className="font-semibold text-[var(--km-fg)]">{order.shopName}</b> · {who} · {formatDateTime(order.createdAt)}
                </p>
              </div>
              <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => onOpenAgent(order.agentId)}>
                看这个代理的账本
              </button>
            </header>
            <dl className="km-od-facts mt-3">
              <div>
                <dt>套餐</dt>
                <dd title={order.planName}>
                  <PlanLabel name={order.planName} />
                </dd>
              </div>
              <div>
                <dt>出卡</dt>
                <dd>
                  {order.issuedCount} / {order.quantity} {order.fulfillmentKind === "local_account" ? "个" : "张"}
                </dd>
              </div>
              <div>
                <dt>单价</dt>
                <dd>¥{yuanTextFromCents(order.unitPriceCents)}</dd>
              </div>
              <div>
                <dt>合计</dt>
                <dd>¥{yuanTextFromCents(order.unitPriceCents * order.issuedCount)}</dd>
              </div>
            </dl>
            {order.lastErrorMessage && order.status !== "delivered" ? (
              <p className="km-od-message">{order.lastErrorMessage}</p>
            ) : null}
            {order.items.length ? (
              <div className="km-dlk-items">
                {order.items.map((item) => {
                  const settle = settleBadge(item);
                  return (
                    <div key={item.id} className={`km-dlk-item${item.matched ? " is-hit" : ""}`}>
                      <code>{item.codeMasked}</code>
                      <span className="km-dlk-cell">¥{yuanTextFromCents(item.amountCents)}</span>
                      <span className="km-dlk-cell">
                        {item.manualUsed ? "已手动核销" : adminStatusLabel(item.cdkStatus, "cdk")}
                      </span>
                      <span className={`km-badge ${settle.tone ? `km-badge-${settle.tone}` : ""}`} title={settle.title || undefined}>
                        {settle.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="km-dlk-empty">这一单还没有出卡。</p>
            )}
          </article>
        );
      })}
    </section>
  );
}
