"use client";

import { useEffect, useState } from "react";
import { adminStatusLabel } from "@/lib/status-labels";

type Item = { id: number; preview: string };
type Redemption = { orderNo: string; fulfillStatus: string; email: string; createdAt: string };
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
};

export function StoreOrderDetail({ orderNo }: { orderNo: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<Record<number, string>>({});

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
  }, [orderNo]);

  async function reveal(id: number) {
    const response = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reveal_cdk", id }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "查看失败");
      return;
    }
    setShown((current) => ({ ...current, [id]: String(data.code || "") }));
  }

  if (error) return <p className="text-xs text-[var(--km-danger)]">{error}</p>;
  if (!detail) return <p className="text-xs text-[var(--km-fg-muted)]">读取订单…</p>;
  const finished = detail.productKind === "finished";
  return (
    <div className="space-y-3 bg-[var(--km-bg-muted)] px-3 py-3 text-xs">
      <p>
        {detail.agent || "—"} · {detail.email || "—"} · {detail.plan} × {detail.quantity} · ¥
        {(detail.grossCents / 100).toFixed(2)} · {detail.channel || "—"} · {adminStatusLabel(detail.payStatus)}
      </p>
      {detail.message ? <p className="text-[var(--km-fg-muted)]">{detail.message}</p> : null}
      <div>
        <p className="mb-1 font-medium">{finished ? "交付内容" : "发出的卡密"}</p>
        {detail.items.length === 0 ? <p className="text-[var(--km-fg-muted)]">还没有交付内容。</p> : null}
        {detail.items.map((item) => (
          <p key={item.id} className="font-mono">
            {shown[item.id] || item.preview || "—"}
            {shown[item.id] ? null : (
              <button type="button" className="ml-2 text-[var(--km-fg-muted)] underline" onClick={() => void reveal(item.id)}>
                查看
              </button>
            )}
          </p>
        ))}
      </div>
      {finished ? null : (
        <div>
          <p className="mb-1 font-medium">兑换记录</p>
          {detail.redemptions.length === 0 ? <p className="text-[var(--km-fg-muted)]">还没有人拿这张卡去兑换。</p> : null}
          {detail.redemptions.map((row) => (
            <p key={row.orderNo}>
              {row.orderNo} · {row.email || "—"} · {adminStatusLabel(row.fulfillStatus)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
