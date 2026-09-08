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
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (no = orderNo, quiet = false) => {
    if (!no.trim()) {
      if (!quiet) setError("请填写订单号");
      return;
    }
    if (!quiet) setBusy(true);
    if (!quiet) setError("");
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
    <section className="km-shell-narrow km-rx-body">
      <div className="km-rx-hero km-rise">
        <h1>订单进度</h1>
        <p>输入订单号，查看开通到哪一步</p>
      </div>
      <div className="km-sf-query km-rise">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="km-sf-query-title">查询订单</h2>
          <p className="km-sf-query-desc">兑换提交后拿到的订单号，可以在这里看开通进度</p>
          <div className="km-sf-query-row">
            <input
              className="km-input"
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              placeholder="粘贴订单号"
              autoComplete="off"
              spellCheck={false}
              aria-label="订单号"
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
            />
            <button
              type="button"
              className="km-btn km-btn-sm km-sf-query-go"
              disabled={busy}
              onClick={() => void load()}
            >
              {busy ? "查询中…" : "查询"}
            </button>
          </div>
          {error ? (
            <p className="km-sf-query-note" style={{ color: "var(--km-danger)" }}>
              {error}
            </p>
          ) : autoPoll ? (
            <p className="km-sf-query-note">处理中，自动刷新…</p>
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
        <p className="km-sf-query-note">没有找到这个订单号。</p>
      ) : null}
    </section>
  );
}
