"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { OrderProgressPanel, type OrderProgressRow, type ProgressEvent } from "@/components/order-progress-panel";
import { isOrderTerminalStatus, normalizeOrderStatus } from "@/lib/order-status";

export function OrderLookupForm() {
  const sp = useSearchParams();
  const [orderNo, setOrderNo] = useState(sp.get("orderNo") || "");
  const [list, setList] = useState<OrderProgressRow[]>([]);
  const [histories, setHistories] = useState<Record<string, ProgressEvent[]>>({});
  const [busy, setBusy] = useState(false);
  const [autoPoll, setAutoPoll] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (no = orderNo, quiet = false) => {
    if (!no.trim()) return;
    if (!quiet) setBusy(true);
    try {
      const res = await fetch(`/api/shop/query?orderNo=${encodeURIComponent(no.trim())}`);
      const data = await res.json();
      const next = (data.list || []) as Array<OrderProgressRow & { history?: ProgressEvent[] }>;
      setList(next);
      const nextHist: Record<string, ProgressEvent[]> = {};
      for (const row of next) {
        const key = String(row.orderNo || "");
        nextHist[key] = (row.history || []).map((h) => ({
          status: normalizeOrderStatus(String(h.status || "")) || String(h.status || ""),
          message: String(h.message || ""),
          at: String(h.at || ""),
        }));
      }
      setHistories(nextHist);
      const row = next[0];
      const st = normalizeOrderStatus(String(row?.fulfillStatus || ""));
      setAutoPoll(Boolean(row) && st !== "" && !isOrderTerminalStatus(st));
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [orderNo]);

  useEffect(() => {
    if (orderNo) void load(orderNo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoPoll || !orderNo.trim()) {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }
    timer.current = setInterval(() => {
      void load(orderNo, true);
    }, 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [autoPoll, orderNo, load]);

  return (
    <section className="km-shell-narrow space-y-6 pb-4">
      <div className="km-page-hero km-rise">
        <p className="km-eyebrow">进度查询</p>
        <h1 className="km-page-title">订单进度</h1>
        <p className="km-lead">输入订单号，查看开通进度。</p>
      </div>
      <div className="km-panel km-form-stack km-rise">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">订单号</span>
          <input
            className="km-input font-mono"
            value={orderNo}
            onChange={(e) => setOrderNo(e.target.value)}
            placeholder="例如 KM-…"
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
          />
        </label>
        <div className="km-form-actions">
          <button className="km-btn" disabled={!orderNo.trim() || busy} onClick={() => void load()}>
            {busy ? "查询中…" : "查询进度"}
          </button>
          {autoPoll ? (
            <span className="text-xs text-[var(--km-fg-muted)]">处理中，自动刷新…</span>
          ) : null}
        </div>
      </div>
      {list.map((o) => (
        <OrderProgressPanel
          key={String(o.orderNo)}
          row={o}
          polling={autoPoll}
          events={histories[String(o.orderNo || "")] || []}
        />
      ))}
      {!busy && orderNo && !list.length ? (
        <p className="text-sm text-[var(--km-fg-muted)]">未找到匹配订单。</p>
      ) : null}
    </section>
  );
}
