"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Product = {
  id: number;
  title: string;
  descriptionHtml: string;
  price: string;
  currency: string;
  stock: number | null;
  upstreamPlan: string;
};

export function ShopCatalog() {
  const [list, setList] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [result, setResult] = useState<{ orderNo: string; codes: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/shop/products?kind=code")
      .then((r) => r.json())
      .then((d) => setList(d.list || []))
      .finally(() => setLoading(false));
  }, []);

  async function buy() {
    if (!productId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/shop/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, email, quantity: qty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "下单失败");
      setResult({ orderNo: data.orderNo, codes: data.codes || [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "下单失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="km-panel">加载商品中…</div>;
  if (!list.length) {
    return (
      <div className="km-panel space-y-2">
        <p>暂无商品。</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-4">
        {list.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setProductId(p.id)}
            className={`km-panel km-panel-hover km-rise w-full text-left ${
              productId === p.id ? "ring-2 ring-[var(--km-accent)]" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
                  {p.title}
                </h3>
                <p className="mt-1 text-sm text-[var(--km-fg-muted)]">套餐 {p.upstreamPlan}</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold">¥{p.price}</div>
                {p.stock !== null ? (
                  <div className="text-xs text-[var(--km-fg-muted)]">库存 {p.stock}</div>
                ) : null}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="km-panel space-y-4">
        <h3 className="text-lg font-semibold">下单</h3>
        <label className="block space-y-1 text-sm">
          <span>邮箱</span>
          <input className="km-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="用于查单" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>数量</span>
          <input
            className="km-input"
            type="number"
            min={1}
            max={10}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value || 1))}
          />
        </label>
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
        <button className="km-btn w-full" disabled={!productId || !email || busy} onClick={buy}>
          {busy ? "处理中…" : "确认购买"}
        </button>
        {result ? (
          <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
            <p>订单号：{result.orderNo}</p>
            <p>卡密：</p>
            <ul className="space-y-1 font-mono">
              {result.codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Link href={`/shop/order/${result.orderNo}`} className="underline">
              打开订单页
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
