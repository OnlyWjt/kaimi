"use client";

import type { ReactNode } from "react";
import { yuanTextFromCents } from "@/lib/money";

export type UsageStatsPayload = {
  orders: {
    placed: number;
    paid: number;
    unpaid: number;
    refunded: number;
    delivered: number;
    partial: number;
    paidUndelivered: number;
  };
  cdks: {
    issued: number;
    unused: number;
    used: number;
    redeeming: number;
    disabled: number;
    unusedBacklog: number;
  };
  localAccountSold: number;
  coupons: Array<{
    id: number;
    agentId: number;
    name: string;
    code: string;
    label: string;
    maxUses: number;
    usedCount: number;
    remaining: number | null;
    enabled: boolean;
    planKeys: string[];
    discountPaidCents: number;
  }>;
  byPlan: Array<{
    planKey: string;
    planName: string;
    placed: number;
    paid: number;
    delivered: number;
    localAccountSold: number;
    cdkIssued: number;
    cdkUnused: number;
  }>;
  byAgent: Array<{
    agentId: number;
    agentName: string;
    placed: number;
    paid: number;
    unusedBacklog: number;
  }>;
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="km-stat">
      <p className="text-sm text-[var(--km-fg-muted)]">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

export function UsageStatsPanel({
  data,
  showAgents,
  planName,
  couponAction,
}: {
  data: UsageStatsPayload;
  showAgents?: boolean;
  planName?: (planKey: string, fallback: string) => string;
  couponAction?: (coupon: UsageStatsPayload["coupons"][number]) => ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="下单" value={data.orders.placed} />
        <Stat label="已支付" value={data.orders.paid} />
        <Stat label="未支付" value={data.orders.unpaid} />
        <Stat label="已退款" value={data.orders.refunded} />
        <Stat label="已发齐" value={data.orders.delivered} />
        <Stat label="部分发货" value={data.orders.partial} />
        <Stat label="已付未发" value={data.orders.paidUndelivered} />
        <Stat label="已售账号" value={data.localAccountSold} />
      </div>
      <div>
        <h3 className="text-sm font-medium">卡密</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="区间已发" value={data.cdks.issued} />
          <Stat label="区间未兑换" value={data.cdks.unused} />
          <Stat label="区间已兑换" value={data.cdks.used} />
          <Stat label="兑换中 / 占用" value={data.cdks.redeeming} />
          <Stat label="当前未兑换积压" value={data.cdks.unusedBacklog} />
        </div>
        {data.cdks.disabled > 0 ? (
          <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
            区间内已禁用 {data.cdks.disabled} 张
          </p>
        ) : null}
      </div>

      {showAgents ? (
        <div className="overflow-x-auto">
          <h3 className="text-sm font-medium">按代理</h3>
          <table className="mt-2 w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">代理</th>
                <th className="py-2 pr-3">下单</th>
                <th className="py-2 pr-3">已付</th>
                <th className="py-2">未兑换积压</th>
              </tr>
            </thead>
            <tbody>
              {data.byAgent.map((row) => (
                <tr key={row.agentId} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3">
                    {row.agentName}
                    {row.unusedBacklog >= 20 ? (
                      <span className="ml-2 text-xs text-[var(--km-danger)]">积压偏高</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">{row.placed}</td>
                  <td className="py-2 pr-3">{row.paid}</td>
                  <td className="py-2">{row.unusedBacklog}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.byAgent.length ? (
            <p className="py-4 text-sm text-[var(--km-fg-muted)]">这段时间没有代理用量</p>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <h3 className="text-sm font-medium">按套餐</h3>
        <table className="mt-2 w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]">
              <th className="py-2 pr-3">套餐</th>
              <th className="py-2 pr-3">下单</th>
              <th className="py-2 pr-3">已付</th>
              <th className="py-2 pr-3">已发齐</th>
              <th className="py-2 pr-3">已售账号</th>
              <th className="py-2 pr-3">区间发卡</th>
              <th className="py-2">未兑换积压</th>
            </tr>
          </thead>
          <tbody>
            {data.byPlan.map((row) => (
              <tr key={row.planKey} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">{planName ? planName(row.planKey, row.planName) : row.planName}</td>
                <td className="py-2 pr-3">{row.placed}</td>
                <td className="py-2 pr-3">{row.paid}</td>
                <td className="py-2 pr-3">{row.delivered}</td>
                <td className="py-2 pr-3">{row.localAccountSold}</td>
                <td className="py-2 pr-3">{row.cdkIssued}</td>
                <td className="py-2">{row.cdkUnused}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.byPlan.length ? (
          <p className="py-4 text-sm text-[var(--km-fg-muted)]">这段时间没有套餐用量</p>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <h3 className="text-sm font-medium">优惠券</h3>
        <table className="mt-2 w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]">
              <th className="py-2 pr-3">名称 / 券码</th>
              <th className="py-2 pr-3">规则</th>
              <th className="py-2 pr-3">次数</th>
              <th className="py-2 pr-3">区间已付减免</th>
              {couponAction ? <th className="py-2">操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.coupons.map((row) => (
              <tr key={row.id} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">
                  <div className="font-medium">{row.name}</div>
                  <div className="font-mono text-xs text-[var(--km-fg-muted)]">{row.code}</div>
                  {!row.enabled ? (
                    <div className="text-xs text-[var(--km-fg-muted)]">已停用</div>
                  ) : null}
                </td>
                <td className="py-2 pr-3">{row.label}</td>
                <td className="py-2 pr-3">
                  {row.maxUses === 0
                    ? `已用 ${row.usedCount} / 不限`
                    : `已用 ${row.usedCount} / ${row.maxUses}`}
                </td>
                <td className="py-2 pr-3">¥{yuanTextFromCents(row.discountPaidCents)}</td>
                {couponAction ? <td className="py-2">{couponAction(row)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
        {!data.coupons.length ? (
          <p className="py-4 text-sm text-[var(--km-fg-muted)]">还没有优惠券</p>
        ) : null}
      </div>
    </div>
  );
}
