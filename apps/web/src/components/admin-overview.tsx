"use client";

import { useEffect, useState } from "react";
import { loadAdminSection, postAdminAction } from "@/components/admin-api";
import { StatCard, StatusBadge, formatWhen } from "@/components/admin-ui";

type Overview = {
  hasCardplatform?: boolean;
  cardplatformSiteBase?: string;
  unusedStock: number;
  lockedCount?: number;
  inflightCount?: number;
  stock: Record<string, number>;
  salesOpen?: boolean;
  salesClosedReason?: string;
  todayPaidCount?: number;
  todayPaidCents?: number;
  attentionCount?: number;
  recentStoreOrders?: Array<{
    orderNo: string;
    productName: string;
    grossCents: number;
    payStatus: string;
    fulfillStatus: string;
    createdAt: string;
    agentName: string;
  }>;
};

export function AdminOverview({
  onGoCommerce,
  onGoStoreOrders,
  onGoGuide,
}: {
  onGoCommerce: () => void;
  onGoStoreOrders: () => void;
  onGoGuide: () => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setOverview(await loadAdminSection<Overview>("overview"));
  }

  useEffect(() => {
    void reload();
  }, []);

  async function act(action: string) {
    setBusy(true);
    try {
      await postAdminAction({ action });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  if (!overview) return null;
  const recent = overview.recentStoreOrders || [];

  return (
    <div className="space-y-4">
      {overview.salesOpen === false ? (
        <button type="button" className="km-ov-alert" onClick={onGoCommerce}>
          <strong>所有店铺已停售，买家现在下不了单</strong>
          <span>
            {overview.salesClosedReason ? `${overview.salesClosedReason} · ` : ""}去「售卖设置」看原因 →
          </span>
        </button>
      ) : null}
      {(overview.lockedCount || 0) > 0 || (overview.inflightCount || 0) > 0 ? (
        <div className="km-panel border-[var(--km-danger)]/40 text-sm">
          {(overview.lockedCount || 0) > 0 ? (
            <p>
              有 <strong>{overview.lockedCount}</strong> 张卡密占用中（locked）。若订单已失败仍锁着，请到「订单」点「修复卡住的锁」。
            </p>
          ) : null}
          {(overview.inflightCount || 0) > 0 ? (
            <p className="mt-1">
              有 <strong>{overview.inflightCount}</strong> 笔开通未结束。服务端每分钟会轮询卡台；也可到订单页手动重拉。
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="km-btn km-btn-ghost text-sm" disabled={busy} onClick={() => void act("reconcile_locks")}>
              修复卡住的锁
            </button>
            <button className="km-btn km-btn-ghost text-sm" disabled={busy} onClick={() => void act("poll_inflight")}>
              立即轮询进行中订单
            </button>
          </div>
        </div>
      ) : null}
      {(overview.attentionCount || 0) > 0 ? (
        <button type="button" className="km-ov-alert" onClick={onGoStoreOrders}>
          <strong>{overview.attentionCount} 笔店铺订单付了款还没发齐</strong>
          <span>去「店铺订单」处理 →</span>
        </button>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="今日成交"
          value={`¥${((overview.todayPaidCents || 0) / 100).toFixed(2)}`}
          hint={`${overview.todayPaidCount || 0} 笔已付款`}
        />
        <StatCard label="待处理订单" value={String(overview.attentionCount || 0)} hint="已付款、还没发齐" />
        <StatCard
          label="已售卡密未兑换"
          value={String(overview.unusedStock)}
          hint={`已核销 ${overview.stock?.used ?? 0} · 已禁用 ${overview.stock?.disabled ?? 0}`}
        />
        <StatCard
          label="卡台接入"
          value={overview.hasCardplatform ? "已配置" : "未配置"}
          hint={overview.cardplatformSiteBase || "去「接入卡台」填写"}
        />
      </div>
      <div className="km-panel overflow-x-auto">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">最近店铺订单</h3>
          <button className="km-btn km-btn-ghost" onClick={onGoStoreOrders}>
            全部店铺订单
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="km-table min-w-[720px] text-sm">
            <colgroup>
              <col style={{ width: "26%" }} />
              <col style={{ width: "26%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>订单</th>
                <th>商品</th>
                <th>代理</th>
                <th>金额</th>
                <th>时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => (
                <tr key={o.orderNo}>
                  <td className="km-clip font-mono text-xs" title={o.orderNo}>
                    {o.orderNo}
                  </td>
                  <td className="km-clip" title={o.productName}>
                    {o.productName}
                  </td>
                  <td className="km-clip" title={o.agentName}>
                    {o.agentName}
                  </td>
                  <td>¥{(o.grossCents / 100).toFixed(2)}</td>
                  <td className="whitespace-nowrap text-xs text-[var(--km-fg-muted)]">{formatWhen(o.createdAt)}</td>
                  <td>
                    <StatusBadge status={o.payStatus === "paid" || o.payStatus === "manual" ? o.fulfillStatus : o.payStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!recent.length ? <p className="py-4 text-sm text-[var(--km-fg-muted)]">还没有店铺订单</p> : null}
      </div>
      <p className="text-sm text-[var(--km-fg-muted)]">
        兑换记录在「订单」里看。第一次开店或客户问流程，看
        <button type="button" className="mx-1 underline" onClick={onGoGuide}>
          使用说明
        </button>
        ；发给代理的短说明在 /start。
      </p>
    </div>
  );
}
