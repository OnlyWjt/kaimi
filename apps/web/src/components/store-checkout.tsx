"use client";

import { FormEvent, useEffect, useState } from "react";

const CHANNEL_LABEL: Record<"alipay" | "wxpay", string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
};

export function StoreCheckout({
  slug,
  planKey,
  channels,
}: {
  slug: string;
  planKey: string;
  channels: Array<"alipay" | "wxpay">;
}) {
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<"alipay" | "wxpay">(
    channels[0] || "alipay",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastOrderNo, setLastOrderNo] = useState("");

  useEffect(() => {
    try {
      const saved = JSON.parse(
        window.sessionStorage.getItem("kaimi-last-store-order") || "{}",
      ) as { orderNo?: string };
      setLastOrderNo(saved.orderNo || "");
    } catch {
      setLastOrderNo("");
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/public/store-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, planKey, channel, customerEmail: email }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "下单失败",
        );
      }
      if (data.orderNo && data.queryToken) {
        window.sessionStorage.setItem(
          `kaimi-order-token:${data.orderNo}`,
          data.queryToken,
        );
        window.sessionStorage.setItem(
          "kaimi-last-store-order",
          JSON.stringify({
            orderNo: data.orderNo,
            token: data.queryToken,
            createdAt: new Date().toISOString(),
          }),
        );
        setLastOrderNo(data.orderNo);
      }
      window.location.href = data.payUrl;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "下单失败");
      setBusy(false);
    }
  }

  if (!channels.length) {
    return (
      <p className="text-sm text-[var(--km-fg-muted)]">支付方式暂未开放</p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span>接收邮箱</span>
        <input
          className="km-input w-full"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="付款成功后用来查单"
          required
        />
      </label>
      <div className="space-y-1 text-sm">
        <span>支付方式</span>
        <div className="km-pay-choices">
          {channels.map((item) => (
            <button
              key={item}
              type="button"
              className="km-pay-choice"
              aria-pressed={channel === item}
              onClick={() => setChannel(item)}
            >
              {CHANNEL_LABEL[item]}
            </button>
          ))}
        </div>
      </div>
      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
      <button className="km-btn km-btn-primary w-full" disabled={busy}>
        {busy ? "正在创建订单…" : "立即购买"}
      </button>
      {lastOrderNo ? (
        <a
          className="block text-center text-sm underline"
          href={`/shop/order/${encodeURIComponent(lastOrderNo)}`}
          onClick={(event) => {
            const token = window.sessionStorage.getItem(
              `kaimi-order-token:${lastOrderNo}`,
            );
            if (!token) return;
            event.preventDefault();
            window.location.href = `/shop/order/${encodeURIComponent(lastOrderNo)}?token=${encodeURIComponent(token)}`;
          }}
        >
          查看最近订单
        </a>
      ) : null}
    </form>
  );
}
