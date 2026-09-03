"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
import { publicStatusLabel } from "@/lib/status-labels";
import {
  looksLikeStoreQueryToken,
  pickStoreQueryToken,
} from "@/lib/store-order-access";

type StoreOrderResult = {
  orderNo: string;
  productName: string;
  amountCents: number;
  payStatus: string;
  fulfillStatus: string;
  message: string;
  code: string | null;
  rechargePath?: string;
  rechargeUrl?: string;
  queryToken?: string;
};

function OrderWait({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  const startedAt = useRef(Date.now());
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="km-order-wait" role="status" aria-live="polite">
      <span className="km-spinner" aria-hidden />
      <p className="font-medium">{title}</p>
      <p className="max-w-[28ch] text-sm leading-6 text-[var(--km-fg-muted)]">
        {detail}
      </p>
      <p className="text-xs text-[var(--km-fg-muted)]">
        已等待 {seconds} 秒，请不要关闭本页
      </p>
    </div>
  );
}

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
    const search = new URLSearchParams(window.location.search);
    const resolvedToken =
      pickStoreQueryToken(search) ||
      (looksLikeStoreQueryToken(token) ? token : "") ||
      window.sessionStorage.getItem(storageKey) ||
      "";
    if (resolvedToken) {
      search.set("qt", resolvedToken);
      window.sessionStorage.setItem(storageKey, resolvedToken);
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    async function load() {
      try {
        const data = await readApiJson<StoreOrderResult>(
          await fetch(
            `/api/public/store-orders/${encodeURIComponent(orderNo)}?${search.toString()}`,
            { cache: "no-store" },
          ),
        );
        if (stopped) return;
        if (data.queryToken && looksLikeStoreQueryToken(data.queryToken)) {
          window.sessionStorage.setItem(storageKey, data.queryToken);
        }
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
          const message =
            reason instanceof Error ? reason.message : "订单查询失败";
          setError(message);
          if (
            message.includes("不存在") ||
            message.includes("凭证")
          ) {
            return;
          }
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

  async function copy(text: string, ok: string) {
    try {
      await copyText(text);
      toast(ok);
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  if (error) return <div className="km-panel mx-auto max-w-[560px]">{error}</div>;
  if (!order) {
    return (
      <div className="km-panel mx-auto max-w-[560px]">
        <OrderWait title="正在确认订单" detail="支付完成后会自动开始生成卡密，请稍候。" />
      </div>
    );
  }

  const rechargePath = order.rechargePath || "/recharge";
  const rechargeUrl =
    order.rechargeUrl ||
    (typeof window !== "undefined" ? `${window.location.origin}${rechargePath}` : rechargePath);

  return (
    <div className="km-panel km-rise mx-auto max-w-[560px] space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{order.productName}</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          ¥{yuanTextFromCents(order.amountCents)} · 支付{" "}
          {publicStatusLabel(order.payStatus, "pay")} · 发卡{" "}
          {publicStatusLabel(order.fulfillStatus, "fulfill")}
        </p>
        <p className="mt-1 font-mono text-xs text-[var(--km-fg-muted)]">{order.orderNo}</p>
      </div>
      {order.code ? (
        <>
          <div className="space-y-2">
            <p className="font-medium">卡密</p>
            <p className="text-sm text-[var(--km-fg-muted)]">请保存，丢失后只能用本页或邮箱查单找回。</p>
            <div className="break-all rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 font-mono text-sm">
              {order.code}
            </div>
            <button
              type="button"
              className="km-btn km-btn-ghost w-full"
              onClick={() => void copy(order.code || "", "卡密已复制")}
            >
              复制卡密
            </button>
          </div>
          <div className="space-y-2">
            <p className="font-medium">兑换链接</p>
            <p className="text-sm text-[var(--km-fg-muted)]">打开后会带上这张卡密，直接校验即可兑换。</p>
            <div className="break-all rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 font-mono text-xs">
              {rechargeUrl}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                className="km-btn km-btn-ghost w-full"
                onClick={() => void copy(rechargeUrl, "兑换链接已复制")}
              >
                复制兑换链接
              </button>
              <Link href={rechargePath} className="km-btn km-btn-primary w-full">
                去兑换
              </Link>
            </div>
          </div>
        </>
      ) : order.fulfillStatus === "unknown" ? (
        <p className="text-sm text-[var(--km-fg-muted)]">
          {order.message ||
            "已收到你的付款，这一笔我们正在确认，确认好会把卡密显示在本页。请不要重复付款。"}
        </p>
      ) : order.payStatus === "paid" ? (
        <OrderWait
          title="正在生成卡密，请稍候"
          detail={
            order.message ||
            "一般几十秒，最多一两分钟。出好了会自动显示在本页，不用刷新。"
          }
        />
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">
          {order.message || "等待支付完成。"}
        </p>
      )}
    </div>
  );
}
