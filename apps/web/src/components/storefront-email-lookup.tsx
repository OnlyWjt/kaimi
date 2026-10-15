"use client";

import { useEffect, useMemo, useState } from "react";
import { RegionBadge } from "@/components/region-badge";
import type { StorefrontText } from "@/components/storefront-i18n";
import { IconMail } from "@/components/storefront-visuals";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
import { publicStatusLabel } from "@/lib/status-labels";

type EmailOrder = {
  /** 打码的订单号。完整订单号是取卡凭证，只凭邮箱拿不到。 */
  orderRef: string;
  productName: string;
  quantity?: number;
  amountCents: number;
  payStatus: string;
  fulfillStatus: string;
  paymentCountry?: string | null;
  regionLabel?: string | null;
};

const QUERY_PREVIEW = 5;
const PAID_PAY = new Set(["paid", "success"]);
const ISSUED_FULFILL = new Set(["delivered", "fulfilled", "success", "issued"]);
const BAD_PAY = new Set(["refunded", "refunding", "chargeback", "closed"]);
const BAD_FULFILL = new Set(["failed", "expired", "cancelled"]);

function isPaidOrder(order: EmailOrder) {
  return PAID_PAY.has(order.payStatus);
}

function isIssuedOrder(order: EmailOrder) {
  return ISSUED_FULFILL.has(order.fulfillStatus);
}

function orderTone(order: EmailOrder): "ok" | "wait" | "bad" {
  if (BAD_PAY.has(order.payStatus) || BAD_FULFILL.has(order.fulfillStatus)) return "bad";
  if (isPaidOrder(order) && isIssuedOrder(order)) return "ok";
  return "wait";
}

function orderRank(order: EmailOrder) {
  const tone = orderTone(order);
  if (tone === "ok") return 0;
  if (isPaidOrder(order)) return 1;
  if (tone === "bad") return 3;
  return 2;
}

function orderStatusText(order: EmailOrder) {
  const pay = publicStatusLabel(order.payStatus, "pay");
  if (!isPaidOrder(order)) return pay;
  const fulfill = publicStatusLabel(order.fulfillStatus, "fulfill");
  return fulfill && fulfill !== pay ? `${pay} · ${fulfill}` : pay;
}

const DEMO_EMAIL_ORDERS: EmailOrder[] = [
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 15000, payStatus: "paid", fulfillStatus: "delivered" },
  { orderRef: "RS2026…2PRO", productName: "Pro", amountCents: 115500, payStatus: "paid", fulfillStatus: "delivered" },
  { orderRef: "RS2026…C500", productName: "Codex 点数 500", amountCents: 22200, payStatus: "paid", fulfillStatus: "issuing" },
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 15000, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…5PRO", productName: "Pro", amountCents: 115500, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 13000, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…C250", productName: "Codex 点数 250", amountCents: 11100, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 15000, payStatus: "refunded", fulfillStatus: "cancelled" },
];

/**
 * 店铺页「邮箱查单」：按邮箱列出这家店的订单（单号打码），交完整单号换查看凭证，
 * 或者把查单链接发到邮箱。预览模式用示例数据，不打接口。
 */
export function StorefrontEmailLookup({
  slug,
  live,
  t,
}: {
  slug: string;
  live: boolean;
  t: StorefrontText;
}) {
  const [queryEmail, setQueryEmail] = useState("");
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [myOrders, setMyOrders] = useState<EmailOrder[] | null>(null);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [canMailLinks, setCanMailLinks] = useState(false);
  const [verifyOrderNo, setVerifyOrderNo] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState("");

  // 买过一次的人回来查单，邮箱直接带上（下单和查单都会存这一项）
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("kaimi-store-email") || "";
      if (saved) setQueryEmail(saved);
    } catch {
      /* sessionStorage 不可用时忽略 */
    }
  }, []);

  const rankedOrders = useMemo(() => {
    if (!myOrders?.length) return [];
    return [...myOrders].sort((a, b) => orderRank(a) - orderRank(b));
  }, [myOrders]);
  const hiddenOrderCount = Math.max(0, rankedOrders.length - QUERY_PREVIEW);
  const visibleOrders = ordersOpen ? rankedOrders : rankedOrders.slice(0, QUERY_PREVIEW);

  async function lookupOrders() {
    const email = queryEmail.trim();
    if (!email) {
      setQueryError(t.queryDesc);
      return;
    }
    if (!live) {
      setMyOrders(DEMO_EMAIL_ORDERS);
      setOrdersOpen(false);
      setQueryError("");
      return;
    }
    setQueryBusy(true);
    setQueryError("");
    try {
      window.sessionStorage.setItem("kaimi-store-email", email);
      const data = await readApiJson<{ list?: EmailOrder[]; canMailLinks?: boolean }>(
        await fetch(
          `/api/public/store-orders?slug=${encodeURIComponent(slug)}&email=${encodeURIComponent(email)}`,
          { cache: "no-store" },
        ),
      );
      const list = data.list || [];
      setMyOrders(list);
      setCanMailLinks(Boolean(data.canMailLinks));
      setVerifyMessage("");
      setOrdersOpen(false);
      if (!list.length) setQueryError(t.queryEmpty);
    } catch (reason) {
      setMyOrders(null);
      setQueryError(reason instanceof Error ? reason.message : "查单失败");
    } finally {
      setQueryBusy(false);
    }
  }

  async function openVerifiedOrder() {
    const orderNo = verifyOrderNo.trim().toUpperCase();
    if (!orderNo || !live) return;
    setVerifyBusy(true);
    setVerifyMessage("");
    try {
      const data = await readApiJson<{ orderNo: string; queryToken: string }>(
        await fetch("/api/public/store-orders/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, email: queryEmail.trim(), orderNo }),
        }),
      );
      window.sessionStorage.setItem(`kaimi-order-token:${data.orderNo}`, data.queryToken);
      window.location.href = `/shop/order/${encodeURIComponent(data.orderNo)}?qt=${encodeURIComponent(data.queryToken)}`;
    } catch (reason) {
      setVerifyMessage(reason instanceof Error ? reason.message : "核对失败");
    } finally {
      setVerifyBusy(false);
    }
  }

  async function mailOrderLinks() {
    if (!live) return;
    setMailBusy(true);
    setVerifyMessage("");
    try {
      const data = await readApiJson<{ message?: string }>(
        await fetch("/api/public/store-orders/send-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, email: queryEmail.trim() }),
        }),
      );
      setVerifyMessage(data.message || "");
    } catch (reason) {
      setVerifyMessage(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      setMailBusy(false);
    }
  }

  return (
        <section id="km-sf-query" className="km-sf-query">
          <div className="km-sf-query-icon" aria-hidden>
            <IconMail />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="km-sf-query-title">{t.queryTitle}</h2>
            <p className="km-sf-query-desc">{t.queryDesc}</p>
            <div className="km-sf-query-row">
              <input
                className="km-input"
                type="email"
                value={queryEmail}
                onChange={(event) => setQueryEmail(event.target.value)}
                placeholder={t.queryPlaceholder}
                aria-label={t.queryTitle}
              />
              <button
                type="button"
                className="km-btn km-btn-sm km-sf-query-go"
                disabled={queryBusy || !queryEmail.trim()}
                onClick={() => void lookupOrders()}
              >
                {queryBusy ? t.queryBusy : t.queryButton}
              </button>
            </div>
            <p className="km-sf-query-note">{queryError || t.queryNote}</p>
            {myOrders?.length ? (
              <div className="km-sf-orders">
                <div className="km-sf-orders-head">
                  <p className="km-sf-query-note">{t.queryScope}</p>
                  <p className="km-sf-orders-count">{t.queryCount(myOrders.length)}</p>
                </div>
                {visibleOrders.map((order, index) => (
                  <div
                    key={`${order.orderRef}-${index}`}
                    className={`km-sf-order-row km-sf-order-${orderTone(order)}`}
                  >
                    <span className="min-w-0">
                      <strong>{order.productName}</strong>
                      <span className="km-sf-order-status font-mono">{order.orderRef}</span>
                      {order.paymentCountry !== null && order.paymentCountry !== undefined ? (
                        <RegionBadge
                          country={order.paymentCountry}
                          regionLabel={order.regionLabel || ""}
                        />
                      ) : null}
                      <span className="km-sf-order-status">
                        {orderStatusText(order)}
                        {(order.quantity || 1) > 1 ? ` · ${order.quantity} 张` : ""}
                      </span>
                    </span>
                    <span className="km-sf-order-amount">
                      ¥{yuanTextFromCents(order.amountCents)}
                    </span>
                  </div>
                ))}
                {hiddenOrderCount > 0 ? (
                  <button
                    type="button"
                    className="km-sf-orders-more"
                    onClick={() => {
                      setOrdersOpen((open) => {
                        if (open) {
                          requestAnimationFrame(() => {
                            document.getElementById("km-sf-query")?.scrollIntoView({
                              behavior: "smooth",
                              block: "start",
                            });
                          });
                        }
                        return !open;
                      });
                    }}
                  >
                    {ordersOpen ? t.queryLess : t.queryMore(hiddenOrderCount)}
                  </button>
                ) : null}
                <div className="space-y-1 pt-2">
                  <p className="km-sf-query-title text-sm">{t.verifyTitle}</p>
                  <p className="km-sf-query-note">{t.verifyDesc}</p>
                  <div className="km-sf-query-row">
                    <input
                      className="km-input font-mono"
                      value={verifyOrderNo}
                      onChange={(event) => setVerifyOrderNo(event.target.value)}
                      placeholder={t.verifyPlaceholder}
                      aria-label={t.verifyTitle}
                    />
                    <button
                      type="button"
                      className="km-btn km-btn-sm km-sf-query-go"
                      disabled={verifyBusy || !verifyOrderNo.trim()}
                      onClick={() => void openVerifiedOrder()}
                    >
                      {verifyBusy ? t.verifyBusy : t.verifyButton}
                    </button>
                  </div>
                  {canMailLinks ? (
                    <button
                      type="button"
                      className="km-sf-orders-more"
                      disabled={mailBusy}
                      onClick={() => void mailOrderLinks()}
                    >
                      {mailBusy ? t.mailLinksBusy : t.mailLinks}
                    </button>
                  ) : null}
                  {verifyMessage ? <p className="km-sf-query-note">{verifyMessage}</p> : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
  );
}
