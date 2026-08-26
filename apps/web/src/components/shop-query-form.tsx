"use client";

import { useState } from "react";

export function ShopQueryForm() {
  const [orderNo, setOrderNo] = useState("");
  const [email, setEmail] = useState("");
  const [list, setList] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function query() {
    setError("");
    setBusy(true);
    try {
      const qs = new URLSearchParams();
      if (orderNo) qs.set("orderNo", orderNo);
      if (email) qs.set("email", email);
      const res = await fetch(`/api/shop/query?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "查询失败");
        return;
      }
      setList(data.list || []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="km-shell-narrow space-y-6 pb-4">
      <div className="km-page-hero km-rise">
        <p className="km-eyebrow">订单检索</p>
        <h1 className="km-page-title">查单</h1>
        <p className="km-lead">用订单号或邮箱查询订单。</p>
      </div>
      <div className="km-panel km-form-stack km-rise">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">订单号</span>
          <input
            className="km-input font-mono"
            placeholder="订单号"
            value={orderNo}
            onChange={(e) => setOrderNo(e.target.value)}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">邮箱</span>
          <input
            className="km-input"
            placeholder="下单邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <div className="km-form-actions">
          <button className="km-btn" disabled={busy || (!orderNo && !email)} onClick={() => void query()}>
            {busy ? "查询中…" : "查询"}
          </button>
        </div>
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
      </div>
      <div className="space-y-3">
        {list.map((o) => (
          <div key={String(o.orderNo)} className="km-panel km-result space-y-1.5">
            <p className="font-medium font-mono">{String(o.orderNo)}</p>
            <p className="text-[var(--km-fg-muted)]">
              {String(o.kind)} · {String(o.payStatus)} · {String(o.fulfillStatus)}
            </p>
            {o.codeMasked || o.email ? (
              <p className="text-sm text-[var(--km-fg-muted)]">
                {o.codeMasked ? `卡密 ${String(o.codeMasked)}` : ""}
                {o.codeMasked && o.email ? " · " : ""}
                {o.email ? `账号 ${String(o.email)}` : ""}
              </p>
            ) : null}
            {Array.isArray(o.codes) && o.codes.length ? (
              <ul className="mt-2 space-y-1 font-mono text-sm">
                {(o.codes as string[]).map((c) => (
                  <li key={c} className="rounded-lg bg-[var(--km-bg-elevated)] px-3 py-2">
                    {c}
                  </li>
                ))}
              </ul>
            ) : null}
            {o.message ? <p className="mt-1">{String(o.message)}</p> : null}
            {Array.isArray(o.history) && o.history.length ? (
              <ul className="mt-2 space-y-1 text-xs text-[var(--km-fg-muted)]">
                {(o.history as Array<{ at?: string; status?: string; message?: string }>).map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    {h.at ? `${h.at} · ` : ""}
                    {h.status}
                    {h.message ? ` · ${h.message}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
