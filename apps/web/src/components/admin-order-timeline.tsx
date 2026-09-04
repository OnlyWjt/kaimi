"use client";

import { useEffect, useState } from "react";
import { adminStatusLabel } from "@/lib/status-labels";

type Snapshot = {
  status: string;
  stage: string;
  message: string;
  accountEmail: string;
  cardLastFour: string;
  fetchedAt: string;
  payloadJson: string;
};

type Event = { step: string; category: string; message: string; at: string };

/**
 * 管理端的卡台明细。这里是全站唯一露出原始报文的地方——里面有卡 id、发卡行、内部
 * 错误码和报价，客户和代理都不该看到，出问题时管理员又必须能看到。
 */
export function AdminOrderTimeline({ orderNo }: { orderNo: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const res = await fetch("/api/admin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "order_timeline", orderNo }),
        });
        const data = await res.json();
        if (stopped) return;
        if (!res.ok) throw new Error(data.error || "读取失败");
        setSnapshot(data.snapshot ?? null);
        setEvents(Array.isArray(data.timeline) ? data.timeline : []);
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : "读取失败");
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [orderNo]);

  if (loading) return <p className="text-xs text-[var(--km-fg-muted)]">读取卡台明细…</p>;
  if (error) return <p className="text-xs text-[var(--km-danger)]">{error}</p>;
  if (!snapshot && !events.length) {
    return <p className="text-xs text-[var(--km-fg-muted)]">这一单还没有卡台明细。</p>;
  }

  return (
    <div className="space-y-3 text-xs">
      {snapshot ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--km-fg-muted)]">
          <span>卡台状态 {snapshot.status || "—"}</span>
          <span>阶段 {snapshot.stage || "—"}</span>
          {snapshot.accountEmail ? <span>账号 {snapshot.accountEmail}</span> : null}
          {snapshot.cardLastFour ? <span>卡尾号 {snapshot.cardLastFour}</span> : null}
          <span>拉取于 {snapshot.fetchedAt}</span>
        </div>
      ) : null}

      {events.length ? (
        <ol className="space-y-1.5 border-l-2 border-[var(--km-border)] pl-3">
          {events.map((event, i) => (
            <li key={`${event.step}-${event.at}-${i}`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">
                  {adminStatusLabel(event.step, "redeemStep")}
                </span>
                <span className="font-mono text-[var(--km-fg-muted)]">
                  {event.category || "—"}
                </span>
                <span className="font-mono text-[var(--km-fg-muted)]">{event.at}</span>
              </div>
              {event.message ? (
                <p className="text-[var(--km-fg-muted)]">{event.message}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {snapshot?.payloadJson ? (
        <details>
          <summary className="cursor-pointer select-none text-[var(--km-fg-muted)]">
            原始响应（调试）
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-[var(--km-radius)] bg-[var(--km-bg-muted)] p-3">
            {snapshot.payloadJson}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
