"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  agentRangeYmd,
  dealLine,
  moneyYuan,
  type AgentCouponItem,
} from "@/lib/agent-console-core";
import { readApiJson } from "@/lib/http-error";
import type { UsageStatsPayload } from "@/components/usage-stats-panel";

type EarningsPayload = {
  summary: {
    orderCount: number;
    grossCents: number;
    pendingCents: number;
  };
  list: Array<{
    id: number;
    orderNo: string;
    productName: string;
    quantity?: number;
    couponCode?: string;
    grossCents: number;
  }>;
};

export function AgentOverview() {
  const [week, setWeek] = useState<EarningsPayload | null>(null);
  const [pendingCents, setPendingCents] = useState(0);
  const [usage, setUsage] = useState<UsageStatsPayload | null>(null);
  const [coupons, setCoupons] = useState<AgentCouponItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { start, end } = agentRangeYmd("7d");
        const [weekData, allData, usageData, couponData] = await Promise.all([
          readApiJson<EarningsPayload>(
            await fetch(`/api/agent/earnings?pageSize=5&start=${start}&end=${end}`, {
              cache: "no-store",
            }),
          ),
          readApiJson<EarningsPayload>(
            await fetch("/api/agent/earnings?pageSize=1", { cache: "no-store" }),
          ),
          readApiJson<UsageStatsPayload>(
            await fetch(`/api/agent/usage/stats?start=${start}&end=${end}`, {
              cache: "no-store",
            }),
          ),
          readApiJson<{ list?: AgentCouponItem[] }>(
            await fetch("/api/agent/coupons", { cache: "no-store" }),
          ),
        ]);
        if (cancelled) return;
        setWeek(weekData);
        setPendingCents(allData.summary.pendingCents);
        setUsage(usageData);
        setCoupons(couponData.list || []);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "概览加载失败");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeCoupons = coupons.filter((item) => item.enabled);
  const risky = activeCoupons.find((item) => item.warnings.length);
  const unused = usage?.cdks.unusedBacklog ?? 0;

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>今天店还好</h1>
          <p>打开后台先看店况，不要先看表格。有风险用一句话点出来，点进去再处理。</p>
        </div>
      </header>
      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
      <div className="km-acp-kpis">
        <div className="km-acp-kpi">
          <span>近 7 天成交</span>
          <strong>{week ? moneyYuan(week.summary.grossCents) : "—"}</strong>
          <small>{week ? `${week.summary.orderCount} 笔已付` : "正在汇总"}</small>
        </div>
        <div className="km-acp-kpi">
          <span>待结算</span>
          <strong>{week ? moneyYuan(pendingCents) : "—"}</strong>
          <small>已扣通道费</small>
        </div>
        <div className="km-acp-kpi">
          <span>未兑换积压</span>
          <strong>{usage ? unused : "—"}</strong>
          <small>发出去还没人兑</small>
        </div>
        <div className="km-acp-kpi">
          <span>在用的券</span>
          <strong>{week ? activeCoupons.length : "—"}</strong>
          <small>
            {risky
              ? `${activeCoupons.filter((item) => item.warnings.length).length} 张有成本提醒`
              : "按当前售价没有成本提醒"}
          </small>
        </div>
      </div>
      <div className="km-acp-grid2">
        <section className="km-panel">
          <div className="km-acp-section-title">
            <div>
              <h2>最近成交</h2>
              <p>确认店还在出单。明细去账本。</p>
            </div>
            <Link href="/agent/books" className="km-btn km-btn-ghost">
              账本
            </Link>
          </div>
          <div className="km-acp-list">
            {(week?.list || []).map((item) => (
              <div key={item.id} className="km-acp-row">
                <div>
                  <b>{dealLine(item)}</b>
                  <span>{item.orderNo}</span>
                </div>
                <strong>{moneyYuan(item.grossCents)}</strong>
              </div>
            ))}
            {week && !week.list.length ? (
              <p className="text-sm text-[var(--km-fg-muted)]">近 7 天还没有成交。</p>
            ) : null}
          </div>
        </section>
        <section className="km-panel">
          <div className="km-acp-section-title">
            <div>
              <h2>要看一眼的</h2>
              <p>没有待办就留白，不要堆零。</p>
            </div>
          </div>
          <div className="km-acp-list">
            {risky ? (
              <Link href="/agent/sell" className="km-acp-row km-acp-todo">
                <div>
                  <b>有一张券可能亏本</b>
                  <span>
                    {risky.name} · {risky.warnings[0]?.message || "用在部分套餐上要复核"}
                  </span>
                </div>
                <span>去看</span>
              </Link>
            ) : null}
            {unused > 0 ? (
              <Link href="/agent/codes" className="km-acp-row">
                <div>
                  <b>{unused} 张卡还没兑</b>
                  <span>不是库存，是已经卖出的卡</span>
                </div>
                <span>去查</span>
              </Link>
            ) : null}
            {week && !risky && unused === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">这会儿没有要立刻处理的事。</p>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
