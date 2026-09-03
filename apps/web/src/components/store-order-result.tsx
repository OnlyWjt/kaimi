"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
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

const PAY_LABEL: Record<string, string> = {
  paid: "已支付",
  unpaid: "未支付",
  pending_pay: "待支付",
  refunded: "已退款",
};

const FULFILL_LABEL: Record<string, string> = {
  delivered: "已发卡",
  paid_undelivered: "已付未发",
  issuing: "发卡中",
  unknown: "核对中",
  pending: "等待中",
  failed: "失败",
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
      await navigator.clipboard.writeText(text);
      toast(ok);
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  if (error) return <div className="km-panel">{error}</div>;
  if (!order) return <div className="km-panel">正在查询订单…</div>;

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
          {PAY_LABEL[order.payStatus] || order.payStatus} · 发卡{" "}
          {FULFILL_LABEL[order.fulfillStatus] || order.fulfillStatus}
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
