"use client";

import { useEffect, useState } from "react";
import { StatusBadge, progressLabel } from "@/components/admin-ui";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { formatDateTime } from "@/lib/datetime";
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

const CHANNEL_LABEL: Record<string, string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
  wechat: "微信支付",
  usdt: "USDT",
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
      toast(data.error || "查看失败", "err");
      return;
    }
    setShown((current) => ({ ...current, [id]: String(data.code || "") }));
  }

  async function copy(value: string) {
    try {
      await copyText(value);
      toast("已复制");
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  if (error) return <div className="km-od km-od-note text-[var(--km-danger)]">{error}</div>;
  if (!detail) return <div className="km-od km-od-note">读取订单…</div>;
  const finished = detail.productKind === "finished";
  const facts: Array<[string, string]> = [
    ["代理", detail.agent || "—"],
    ["买家邮箱", detail.email || "—"],
    ["商品", `${detail.plan} × ${detail.quantity}`],
    ["金额", `¥${(detail.grossCents / 100).toFixed(2)}`],
    ["支付", `${CHANNEL_LABEL[detail.channel] || detail.channel || "—"} · ${adminStatusLabel(detail.payStatus, "pay")}`],
    ["发卡", progressLabel(finished ? "finished" : "store", detail.fulfillStatus)],
    ["下单时间", formatDateTime(detail.createdAt)],
  ];

  return (
    <div className="km-od">
      <dl className="km-od-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      {detail.message ? <p className="km-od-message">{detail.message}</p> : null}
      <div className={`km-od-grid${finished ? " is-single" : ""}`}>
        <section className="km-od-block">
          <h4>
            {finished ? "交付内容" : "发出的卡密"}
            <span>{detail.items.length}</span>
          </h4>
          {detail.items.length === 0 ? <p className="km-od-empty">还没有交付内容。</p> : null}
          {detail.items.map((item) => {
            const plain = shown[item.id];
            return (
              <div key={item.id} className="km-od-line">
                <code>{plain || item.preview || "—"}</code>
                {plain ? (
                  <button type="button" className="km-od-act" onClick={() => void copy(plain)}>
                    复制
                  </button>
                ) : (
                  <button type="button" className="km-od-act" onClick={() => void reveal(item.id)}>
                    查看
                  </button>
                )}
              </div>
            );
          })}
        </section>
        {finished ? null : (
          <section className="km-od-block">
            <h4>
              兑换记录
              <span>{detail.redemptions.length}</span>
            </h4>
            {detail.redemptions.length === 0 ? <p className="km-od-empty">还没有人拿这张卡去兑换。</p> : null}
            {detail.redemptions.map((row) => (
              <div key={row.orderNo} className="km-od-line">
                <div className="min-w-0">
                  <code>{row.orderNo}</code>
                  <p className="km-od-sub">
                    {row.email || "—"} · {formatDateTime(row.createdAt)}
                  </p>
                </div>
                <StatusBadge status={row.fulfillStatus} />
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
