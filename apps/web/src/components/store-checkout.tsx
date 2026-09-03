"use client";

import { FormEvent, useEffect, useState } from "react";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";

const CHANNEL_LABEL: Record<"alipay" | "wxpay", string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
};

const CHANNEL_HINT: Record<"alipay" | "wxpay", string> = {
  alipay: "支持花呗、余额、银行卡",
  wxpay: "支持微信扫码或零钱",
};

const PAY_LABEL: Record<string, string> = {
  paid: "已支付",
  unpaid: "未支付",
  refunded: "已退款",
};

const FULFILL_LABEL: Record<string, string> = {
  delivered: "已发卡",
  paid_undelivered: "发卡中",
  issuing: "发卡中",
  pending: "待支付",
  unknown: "核对中",
};

type EmailOrder = {
  orderNo: string;
  productName: string;
  amountCents: number;
  payStatus: string;
  fulfillStatus: string;
  queryToken: string;
};

function PayLogo({ channel }: { channel: "alipay" | "wxpay" }) {
  if (channel === "alipay") {
    return (
      <span className="km-pay-logo km-pay-logo-alipay" aria-hidden>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M5 12.4h14c.5 0 .9.4.9.9s-.4.9-.9.9h-5.4c1.3 1.8 3.1 3.3 5.2 4.3.5.2.7.8.4 1.3-.2.5-.8.7-1.3.4-2.5-1.2-4.6-3-6.1-5.1-1.7 2.2-4.1 4-6.9 5.1-.5.2-1.1 0-1.3-.5s0-1.1.5-1.3c2.5-1 4.6-2.7 6-4.8H5c-.5 0-.9-.4-.9-.9s.4-.9.9-.9Z" />
        </svg>
      </span>
    );
  }

  return (
    <span className="km-pay-logo km-pay-logo-wxpay" aria-hidden>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
        <path d="M9.4 4.2C6 4.2 3.2 6.5 3.2 9.3c0 1.6.9 3 2.3 4l-.3 1.1c-.1.3.2.6.5.4l1.5-.7c.5.1 1 .2 1.5.2.3 0 .6 0 .8-.1-.4-1.3.2-2.7 1.5-3.8 1.1-.9 2.5-1.4 3.9-1.5-.6-2.3-3-4.7-6-4.7Zm-1.9 3.2a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Zm4 0a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7ZM16.2 9.1c-2.6 0-4.7 1.8-4.7 4.1s2.1 4.1 4.7 4.1c.5 0 .9 0 1.3-.2l1.2.6c.3.1.6-.2.5-.5l-.2-.9c1.2-.8 1.9-1.9 1.9-3.1 0-2.3-2.1-4.1-4.7-4.1Zm-1.6 2.6a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Zm3.2 0a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z" />
      </svg>
    </span>
  );
}

export type ShopPlan = {
  planKey: string;
  name: string;
  description: string;
  retailPriceCents: number;
};

export function StoreCheckout({
  slug,
  plans,
  channels,
}: {
  slug: string;
  plans: ShopPlan[];
  channels: Array<"alipay" | "wxpay">;
}) {
  const [planKey, setPlanKey] = useState(plans[0]?.planKey || "");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<"alipay" | "wxpay">(
    channels[0] || "alipay",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [myOrders, setMyOrders] = useState<EmailOrder[] | null>(null);

  const selected = plans.find((item) => item.planKey === planKey) || plans[0];

  useEffect(() => {
    try {
      const savedEmail = window.sessionStorage.getItem("kaimi-store-email") || "";
      if (savedEmail) setEmail(savedEmail);
    } catch {
      /* ignore */
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      window.sessionStorage.setItem("kaimi-store-email", email.trim());
      const data = await readApiJson<{
        orderNo?: string;
        queryToken?: string;
        payUrl?: string;
      }>(
        await fetch("/api/public/store-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            planKey: selected.planKey,
            channel,
            customerEmail: email,
          }),
        }),
      );
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
      }
      if (!data.payUrl) throw new Error("未拿到支付链接，请稍后重试");
      window.location.href = data.payUrl;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "下单失败");
      setBusy(false);
    }
  }

  async function lookupMyOrders() {
    const nextEmail = email.trim();
    if (!nextEmail) {
      setLookupError("请先填写接收邮箱");
      return;
    }
    setLookupBusy(true);
    setLookupError("");
    try {
      window.sessionStorage.setItem("kaimi-store-email", nextEmail);
      const data = await readApiJson<{ list?: EmailOrder[] }>(
        await fetch(
          `/api/public/store-orders?slug=${encodeURIComponent(slug)}&email=${encodeURIComponent(nextEmail)}`,
          { cache: "no-store" },
        ),
      );
      const list = data.list || [];
      setMyOrders(list);
      if (!list.length) setLookupError("这个邮箱在本店还没有订单");
    } catch (reason) {
      setMyOrders(null);
      setLookupError(reason instanceof Error ? reason.message : "查单失败");
    } finally {
      setLookupBusy(false);
    }
  }

  if (!plans.length) {
    return <p className="text-sm text-[var(--km-fg-muted)]">当前暂无可售套餐。</p>;
  }

  if (!channels.length) {
    return (
      <p className="text-sm text-[var(--km-fg-muted)]">支付方式暂未开放</p>
    );
  }

  return (
    <div className="km-shop">
      <div className="space-y-3">
        {plans.map((plan) => (
          <button
            key={plan.planKey}
            type="button"
            className={`km-plan-pick ${plan.planKey === selected?.planKey ? "km-plan-pick-active" : ""}`}
            onClick={() => setPlanKey(plan.planKey)}
          >
            <div className="min-w-0">
              <p className="text-lg font-semibold">{plan.name}</p>
              <p className="mt-1 text-sm leading-6 text-[var(--km-fg-muted)]">
                {plan.description || "付款成功后即时发卡"}
              </p>
            </div>
            <p className="shrink-0 text-2xl font-semibold tracking-tight">
              ¥{yuanTextFromCents(plan.retailPriceCents)}
            </p>
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="km-shop-pay space-y-4">
        <div>
          <p className="text-sm text-[var(--km-fg-muted)]">当前选择</p>
          <h2 className="mt-1 text-xl font-semibold">{selected?.name}</h2>
          <p className="mt-2 text-3xl font-semibold tracking-tight">
            ¥{yuanTextFromCents(selected?.retailPriceCents || 0)}
          </p>
        </div>
        <label className="block space-y-1.5 text-sm">
          <span>接收邮箱</span>
          <input
            className="km-input w-full"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="付款成功后用这个邮箱查自己的订单"
            required
          />
        </label>
        <div className="space-y-1.5 text-sm">
          <span>支付方式</span>
          <div className="km-pay-list" role="radiogroup" aria-label="支付方式">
            {channels.map((item) => {
              const selectedChannel = channel === item;
              return (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={selectedChannel}
                  data-channel={item}
                  className="km-pay-row"
                  onClick={() => setChannel(item)}
                >
                  <PayLogo channel={item} />
                  <span className="min-w-0">
                    <span className="block font-medium">{CHANNEL_LABEL[item]}</span>
                    <span className="mt-0.5 block text-xs text-[var(--km-fg-muted)]">
                      {CHANNEL_HINT[item]}
                    </span>
                  </span>
                  <span className="km-pay-radio" aria-hidden />
                </button>
              );
            })}
          </div>
        </div>
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
        <button className="km-btn km-btn-primary w-full" disabled={busy || !selected}>
          {busy ? "正在创建订单…" : "立即购买"}
        </button>
        <button
          type="button"
          className="km-btn km-btn-ghost w-full"
          disabled={lookupBusy}
          onClick={() => void lookupMyOrders()}
        >
          {lookupBusy ? "正在查询…" : "用邮箱查询我的订单"}
        </button>
        {lookupError ? (
          <p className="text-center text-sm text-[var(--km-fg-muted)]">{lookupError}</p>
        ) : null}
        {myOrders?.length ? (
          <div className="space-y-2">
            <p className="text-xs text-[var(--km-fg-muted)]">
              只显示这个邮箱在本店的订单，和其他买家互不影响。
            </p>
            {myOrders.map((item) => {
              const href = item.queryToken
                ? `/shop/order/${encodeURIComponent(item.orderNo)}?qt=${encodeURIComponent(item.queryToken)}`
                : `/shop/order/${encodeURIComponent(item.orderNo)}`;
              return (
                <a
                  key={item.orderNo}
                  className="km-plan-pick"
                  href={href}
                >
                  <div className="min-w-0">
                    <p className="font-medium">{item.productName}</p>
                    <p className="mt-1 font-mono text-xs text-[var(--km-fg-muted)]">
                      {item.orderNo}
                    </p>
                    <p className="mt-1 text-xs text-[var(--km-fg-muted)]">
                      {PAY_LABEL[item.payStatus] || item.payStatus} ·{" "}
                      {FULFILL_LABEL[item.fulfillStatus] || item.fulfillStatus}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-semibold">
                    ¥{yuanTextFromCents(item.amountCents)}
                  </p>
                </a>
              );
            })}
          </div>
        ) : null}
      </form>
    </div>
  );
}
