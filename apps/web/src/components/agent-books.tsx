"use client";

import { useEffect, useState } from "react";
import type { UsageStatsPayload } from "@/components/usage-stats-panel";
import {
  agentEarningsQuery,
  agentRangeYmd,
  moneyYuan,
  type AgentRangeKey,
} from "@/lib/agent-console-core";
import { formatDateTime } from "@/lib/datetime";
import { readApiJson } from "@/lib/http-error";
import { publicStatusLabel } from "@/lib/status-labels";

type EarningsPayload = {
  summary: {
    orderCount: number;
    grossCents: number;
    paymentFeeCents: number;
    pendingCents: number;
  };
  list: Array<{
    id: number;
    confirmedAt: string;
    orderNo: string;
    productName: string;
    quantity?: number;
    couponCode?: string;
    grossCents: number;
    paymentFeeCents: number;
    earningCents: number;
    feeReconcileStatus: string;
  }>;
};

type Settlement = {
  id: number;
  settlementNo: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  status: string;
};

const RANGES: Array<[AgentRangeKey, string]> = [
  ["today", "今天"],
  ["7d", "近 7 天"],
  ["month", "本月"],
  ["all", "全部"],
];

export function AgentBooks() {
  const [range, setRange] = useState<AgentRangeKey>("7d");
  const [earnings, setEarnings] = useState<EarningsPayload | null>(null);
  const [usage, setUsage] = useState<UsageStatsPayload | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError("");
      try {
        const { start, end } = agentRangeYmd(range);
        const [earningsData, usageData, settlementData] = await Promise.all([
          readApiJson<EarningsPayload>(
            await fetch(`/api/agent/earnings?pageSize=20${agentEarningsQuery(range)}`, {
              cache: "no-store",
            }),
          ),
          readApiJson<UsageStatsPayload>(
            await fetch(`/api/agent/usage/stats?start=${start}&end=${end}`, {
              cache: "no-store",
            }),
          ),
          readApiJson<{ list?: Settlement[] }>(
            await fetch("/api/agent/settlements", { cache: "no-store" }),
          ),
        ]);
        if (cancelled) return;
        setEarnings(earningsData);
        setUsage(usageData);
        setSettlements(settlementData.list || []);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "账本加载失败");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const couponOff = usage?.coupons.reduce((sum, item) => sum + item.discountPaidCents, 0) ?? 0;

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>账本</h1>
          <p>钱和量用同一段时间。上面看赚到没有，中间看单走没走完，下面才是明细。</p>
        </div>
        <div className="km-acp-tools">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={range === value ? "km-btn" : "km-btn km-btn-ghost"}
              onClick={() => setRange(value)}
            >
              {label}
            </button>
          ))}
          <a
            className="km-btn km-btn-ghost"
            href={`/api/agent/earnings/export.xlsx?${agentEarningsQuery(range).replace(/^&/, "")}`}
          >
            导出
          </a>
        </div>
      </header>
      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}

      <div className="km-acp-kpis">
        <div className="km-acp-kpi">
          <span>成交额</span>
          <strong>{earnings ? moneyYuan(earnings.summary.grossCents) : "—"}</strong>
          <small>{earnings ? `${earnings.summary.orderCount} 笔` : ""}</small>
        </div>
        <div className="km-acp-kpi">
          <span>通道费</span>
          <strong>{earnings ? moneyYuan(earnings.summary.paymentFeeCents) : "—"}</strong>
        </div>
        <div className="km-acp-kpi">
          <span>待结算</span>
          <strong>{earnings ? moneyYuan(earnings.summary.pendingCents) : "—"}</strong>
        </div>
        <div className="km-acp-kpi">
          <span>券减免</span>
          <strong>{usage ? moneyYuan(couponOff) : "—"}</strong>
        </div>
      </div>

      <section className="km-panel">
        <div className="km-acp-section-title">
          <div>
            <h2>这段时间的单</h2>
            <p>用量不再另开一页。下单、已付、未兑放在账本里，一眼能对上钱。</p>
          </div>
        </div>
        <div className="km-acp-kpis">
          <div className="km-acp-kpi">
            <span>下单</span>
            <strong>{usage ? usage.orders.placed : "—"}</strong>
          </div>
          <div className="km-acp-kpi">
            <span>已付</span>
            <strong>{usage ? usage.orders.paid : "—"}</strong>
          </div>
          <div className="km-acp-kpi">
            <span>已发齐</span>
            <strong>{usage ? usage.orders.delivered : "—"}</strong>
          </div>
          <div className="km-acp-kpi">
            <span>未兑换</span>
            <strong>{usage ? usage.cdks.unusedBacklog : "—"}</strong>
            <small>当前积压，不只看这一段</small>
          </div>
        </div>
      </section>

      <section className="km-panel space-y-4">
        <div className="km-acp-section-title">
          <div>
            <h2>成交明细</h2>
            <p>已按代理成本和支付通道费算过收益。开票加价归平台、不计入佣金。</p>
          </div>
        </div>
        {earnings?.list.length ? (
          <div className="overflow-x-auto">
            <table className="km-acp-price">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>订单</th>
                  <th>套餐</th>
                  <th>实付</th>
                  <th>手续费</th>
                  <th>收益</th>
                  <th>手续费口径</th>
                </tr>
              </thead>
              <tbody>
                {earnings.list.map((item) => (
                  <tr key={item.id}>
                    <td title={item.confirmedAt}>{formatDateTime(item.confirmedAt)}</td>
                    <td>{item.orderNo}</td>
                    <td>
                      {item.productName}
                      {item.couponCode ? ` · ${item.couponCode}` : ""}
                    </td>
                    <td>{moneyYuan(item.grossCents)}</td>
                    <td>{moneyYuan(item.paymentFeeCents)}</td>
                    <td>{moneyYuan(item.earningCents)}</td>
                    <td>{publicStatusLabel(item.feeReconcileStatus, "fee")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--km-fg-muted)]">这段时间没有成交。</p>
        )}
      </section>

      <section className="km-panel">
        <div className="km-acp-section-title">
          <div>
            <h2>结算</h2>
            <p>打过款的单独成行，不要和每天的收益表混成一张。</p>
          </div>
        </div>
        <div className="km-acp-list">
          {settlements.map((item) => (
            <div key={item.id} className="km-acp-row">
              <div>
                <b>{item.settlementNo}</b>
                <span>
                  {item.periodStart.slice(0, 10)} 至 {item.periodEnd.slice(0, 10)}
                </span>
              </div>
              <div className="text-right">
                <b>{moneyYuan(item.amountCents)}</b>
                <span className="km-acp-pill">{publicStatusLabel(item.status, "settlement")}</span>
              </div>
            </div>
          ))}
          {!settlements.length ? (
            <p className="text-sm text-[var(--km-fg-muted)]">暂无结算记录</p>
          ) : null}
        </div>
      </section>
    </>
  );
}
