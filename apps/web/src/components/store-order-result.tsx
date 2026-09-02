"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type StoreOrderResult = {
  orderNo: string;
  productName: string;
  amountCents: number;
  payStatus: string;
  fulfillStatus: string;
  message: string;
  code: string | null;
};

export function StoreOrderResultPanel({
  orderNo,
  token,
}: {
  orderNo: string;
  token: string;
}) {
  const [order, setOrder] = useState<StoreOrderResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const storageKey = `kaimi-order-token:${orderNo}`;
    const resolvedToken = token || window.sessionStorage.getItem(storageKey) || "";
    if (!resolvedToken) {
      setError("缺少订单查询凭证，请从支付完成页面重新进入");
      return;
    }
    window.sessionStorage.setItem(storageKey, resolvedToken);
    if (token) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.hash}`,
      );
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    async function load() {
      try {
        const response = await fetch(
          `/api/public/store-orders/${encodeURIComponent(orderNo)}?token=${encodeURIComponent(resolvedToken)}`,
          { cache: "no-store" },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "订单查询失败");
        if (stopped) return;
        setOrder(data);
        setError("");
        failures = 0;
        if (
          data.fulfillStatus !== "delivered" &&
          data.payStatus !== "refunded"
        ) {
          timer = setTimeout(
            load,
            data.fulfillStatus === "unknown" ? 15_000 : 3000,
          );
        }
      } catch (reason) {
        if (!stopped) {
          setError(reason instanceof Error ? reason.message : "订单查询失败");
          failures += 1;
          timer = setTimeout(load, Math.min(3000 * failures, 15_000));
        }
      }
    }
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderNo, token]);

  if (error) return <div className="km-panel">{error}</div>;
  if (!order) return <div className="km-panel">正在查询订单…</div>;

  return (
    <div className="km-panel km-rise mx-auto max-w-[560px] space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{order.productName}</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          ¥{(order.amountCents / 100).toFixed(2)} · 支付 {order.payStatus} ·
          发卡 {order.fulfillStatus}
        </p>
      </div>
      {order.code ? (
        <>
          <div className="space-y-2">
            <p className="font-medium">卡密（请妥善保存）</p>
            <div className="break-all rounded-lg bg-[var(--km-bg-muted)] px-3 py-3 font-mono text-sm">
              {order.code}
            </div>
            <button
              type="button"
              className="km-btn km-btn-ghost w-full"
              onClick={() => navigator.clipboard.writeText(order.code || "")}
            >
              复制卡密
            </button>
          </div>
          <Link href="/recharge" className="km-btn km-btn-primary w-full">
            去兑换
          </Link>
        </>
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">
          {order.message ||
            (order.payStatus === "paid"
              ? "支付成功，正在生成卡密…"
              : "等待支付完成。")}
        </p>
      )}
    </div>
  );
}
