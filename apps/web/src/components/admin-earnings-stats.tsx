"use client";

import { useEffect, useMemo, useState } from "react";
import { readApiJson } from "@/lib/http-error";
import type { StatsGrain } from "@/lib/earnings-stats-core";

type AgentOption = { id: number; displayName: string };

type Money = {
  orderCount: number;
  grossCents: number;
  platformCents: number;
  agentCents: number;
  feeCents: number;
  pendingCents: number;
  settledCents: number;
  reversedCents: number;
  adjustmentCents: number;
};

type NamedMoney = Money & { key: string; label: string };

type Pipeline = {
  placedCount: number;
  placedCents: number;
  paidCount: number;
  paidCents: number;
  unpaidCount: number;
  unpaidCents: number;
  deliveredCount: number;
  stuckCount: number;
  stuckCents: number;
  refundedCount: number;
  refundedCents: number;
  feeReviewCount: number;
  feePendingCount: number;
};

type StatsPayload = {
  range: { start: string; end: string; grain: StatsGrain };
  totals: Money;
  byAgent: Array<Money & { agentId: number; agentName: string }>;
  series: Array<Money & { bucket: string; label: string }>;
  byChannel: NamedMoney[];
  byPlan: NamedMoney[];
  byFee: NamedMoney[];
  pipeline: Pipeline;
};

const emptyMoney: Money = {
  orderCount: 0,
  grossCents: 0,
  platformCents: 0,
  agentCents: 0,
  feeCents: 0,
  pendingCents: 0,
  settledCents: 0,
  reversedCents: 0,
  adjustmentCents: 0,
};

const emptyPipeline: Pipeline = {
  placedCount: 0,
  placedCents: 0,
  paidCount: 0,
  paidCents: 0,
  unpaidCount: 0,
  unpaidCents: 0,
  deliveredCount: 0,
  stuckCount: 0,
  stuckCents: 0,
  refundedCount: 0,
  refundedCents: 0,
  feeReviewCount: 0,
  feePendingCount: 0,
};

function localYmd(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function mondayYmd(date = new Date()) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = copy.getDay();
  copy.setDate(copy.getDate() - (weekday === 0 ? 6 : weekday - 1));
  return localYmd(copy);
}

function monthStartYmd(date = new Date()) {
  return localYmd(new Date(date.getFullYear(), date.getMonth(), 1));
}

function yuan(cents: number) {
  const value = (Math.abs(cents) / 100).toFixed(2);
  return cents < 0 ? `-¥${value}` : `¥${value}`;
}

type Preset = "today" | "week" | "month" | "custom";

const PLATFORM = "var(--km-fg)";
const AGENT = "var(--km-accent)";
const FEE = "var(--km-fg-muted)";

function GroupedBarChart({
  rows,
  series,
}: {
  rows: Array<{ label: string; platformCents: number; agentCents: number; feeCents?: number }>;
  series: Array<{ key: "platformCents" | "agentCents" | "feeCents"; label: string; color: string }>;
}) {
  if (!rows.length) {
    return <p className="py-10 text-center text-sm text-[var(--km-fg-muted)]">这段时间还没有已入账的单</p>;
  }
  const max = Math.max(
    1,
    ...rows.flatMap((row) => series.map((item) => Number(row[item.key]) || 0)),
  );
  const width = Math.max(560, rows.length * 72);
  const height = 240;
  const pad = { top: 16, right: 8, bottom: 40, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const groupW = innerW / rows.length;
  const barW = Math.min(16, Math.max(6, (groupW - 10) / series.length));

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="收益柱状图">
        {rows.map((row, index) => {
          const groupX = pad.left + index * groupW + groupW / 2;
          return (
            <g key={`${row.label}-${index}`}>
              {series.map((item, offset) => {
                const value = Number(row[item.key]) || 0;
                const barH = (Math.max(0, value) / max) * innerH;
                const x = groupX - (series.length * barW) / 2 + offset * barW;
                const y = pad.top + innerH - barH;
                return (
                  <rect
                    key={item.key}
                    x={x}
                    y={y}
                    width={Math.max(barW - 2, 1)}
                    height={Math.max(barH, value > 0 ? 2 : 0)}
                    fill={item.color}
                    rx="2"
                  >
                    <title>{`${row.label} ${item.label} ${yuan(value)}`}</title>
                  </rect>
                );
              })}
              <text
                x={groupX}
                y={height - 16}
                textAnchor="middle"
                fill="var(--km-fg-muted)"
                fontSize="11"
              >
                {row.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function HorizonBars({
  rows,
  valueKey,
  labelKey,
  color,
}: {
  rows: Array<Record<string, string | number>>;
  valueKey: string;
  labelKey: string;
  color: string;
}) {
  if (!rows.length) {
    return <p className="py-8 text-center text-sm text-[var(--km-fg-muted)]">暂无数据</p>;
  }
  const max = Math.max(1, ...rows.map((row) => Math.abs(Number(row[valueKey]) || 0)));
  return (
    <div className="space-y-2.5">
      {rows.map((row) => {
        const value = Number(row[valueKey]) || 0;
        const width = `${Math.max(4, (Math.abs(value) / max) * 100)}%`;
        return (
          <div key={String(row[labelKey])} className="grid grid-cols-[7rem_1fr_5.5rem] items-center gap-3 text-sm">
            <span className="truncate text-[var(--km-fg-muted)]">{row[labelKey]}</span>
            <div className="h-2.5 overflow-hidden rounded-full bg-[var(--km-bg-muted)]">
              <div className="h-full rounded-full" style={{ width, background: color }} />
            </div>
            <span className="text-right font-medium">{yuan(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ChartLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-[var(--km-fg-muted)]">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function AdminEarningsStats() {
  const [preset, setPreset] = useState<Preset>("month");
  const [grain, setGrain] = useState<StatsGrain>("day");
  const [agentId, setAgentId] = useState(0);
  const [start, setStart] = useState(monthStartYmd);
  const [end, setEnd] = useState(localYmd);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [data, setData] = useState<StatsPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => {
    if (preset === "today") return { start: localYmd(), end: localYmd() };
    if (preset === "week") return { start: mondayYmd(), end: localYmd() };
    if (preset === "month") return { start: monthStartYmd(), end: localYmd() };
    return { start, end };
  }, [preset, start, end]);

  useEffect(() => {
    let cancelled = false;
    async function loadAgents() {
      try {
        const payload = await readApiJson<{ list?: AgentOption[] }>(
          await fetch("/api/admin/agents", { cache: "no-store" }),
        );
        if (!cancelled) setAgents(payload.list || []);
      } catch {
        if (!cancelled) setAgents([]);
      }
    }
    void loadAgents();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setBusy(true);
      setError("");
      try {
        const qs = new URLSearchParams({
          start: range.start,
          end: range.end,
          grain,
        });
        if (agentId > 0) qs.set("agentId", String(agentId));
        const payload = await readApiJson<StatsPayload>(
          await fetch(`/api/admin/earnings/stats?${qs}`, { cache: "no-store" }),
        );
        if (!cancelled) setData(payload);
      } catch (reason) {
        if (!cancelled) {
          setData(null);
          setError(reason instanceof Error ? reason.message : "统计加载失败");
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [range.start, range.end, grain, agentId]);

  const totals = data?.totals || emptyMoney;
  const pipeline = data?.pipeline || emptyPipeline;
  const avgCents = totals.orderCount ? Math.round(totals.grossCents / totals.orderCount) : 0;
  const platformShare = totals.grossCents
    ? Math.round((totals.platformCents / totals.grossCents) * 100)
    : 0;
  const exportHref = `/api/admin/earnings/export.xlsx?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}${agentId > 0 ? `&agentId=${agentId}` : ""}`;

  return (
    <div className="space-y-6">
      <section className="km-panel space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">收益统计</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              平台收益是代理成本合计，代理收益是佣金。只把已支付且已发卡的单算进赚；漏斗按区间内下单/付款看。
            </p>
          </div>
          <a href={exportHref} className="km-btn km-btn-ghost km-btn-sm">
            导出这段 Excel
          </a>
        </div>

        <div className="flex flex-wrap gap-2">
          {(
            [
              ["today", "今天"],
              ["week", "本周"],
              ["month", "本月"],
              ["custom", "自定义"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`km-tab ${preset === id ? "km-tab-active" : ""}`}
              onClick={() => setPreset(id)}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 hidden h-6 w-px bg-[var(--km-border)] sm:block" />
          {(
            [
              ["day", "按天"],
              ["week", "按周"],
              ["month", "按月"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`km-tab ${grain === id ? "km-tab-active" : ""}`}
              onClick={() => setGrain(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {preset === "custom" ? (
            <>
              <input
                className="km-input"
                type="date"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
              <input
                className="km-input"
                type="date"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </>
          ) : (
            <p className="self-center text-sm text-[var(--km-fg-muted)] md:col-span-2">
              {range.start} 至 {range.end}
            </p>
          )}
          <select
            className="km-input"
            value={agentId}
            onChange={(event) => setAgentId(Number(event.target.value))}
          >
            <option value={0}>全部代理</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName}
              </option>
            ))}
          </select>
        </div>
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
        {busy ? <p className="text-xs text-[var(--km-fg-muted)]">正在汇总…</p> : null}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">平台收益</p>
          <p className="text-2xl font-semibold">{yuan(totals.platformCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">占销售额 {platformShare}%</p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">代理收益</p>
          <p className="text-2xl font-semibold">{yuan(totals.agentCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            待结算 {yuan(totals.pendingCents)} · 已返佣 {yuan(totals.settledCents)}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">销售额</p>
          <p className="text-2xl font-semibold">{yuan(totals.grossCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            {totals.orderCount} 单 · 客单 {yuan(avgCents)}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">支付手续费</p>
          <p className="text-2xl font-semibold">{yuan(totals.feeCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">给渠道，不进两边收益</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">已支付未出齐</p>
          <p className="text-2xl font-semibold">{pipeline.stuckCount}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">{yuan(pipeline.stuckCents)} 还不能结算</p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">未支付</p>
          <p className="text-2xl font-semibold">{pipeline.unpaidCount}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">{yuan(pipeline.unpaidCents)}</p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">退款 / 冲正</p>
          <p className="text-2xl font-semibold">{yuan(totals.adjustmentCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            退款 {pipeline.refundedCount} 单 · 冲正 {yuan(totals.reversedCents)}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">手续费待核</p>
          <p className="text-2xl font-semibold">{pipeline.feeReviewCount + pipeline.feePendingCount}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            待人工 {pipeline.feeReviewCount} · 核对中 {pipeline.feePendingCount}
          </p>
        </div>
      </div>

      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">平台 vs 代理</h3>
          <ChartLegend
            items={[
              { label: "平台收益", color: PLATFORM },
              { label: "代理收益", color: AGENT },
            ]}
          />
        </div>
        <GroupedBarChart
          rows={data?.series || []}
          series={[
            { key: "platformCents", label: "平台收益", color: PLATFORM },
            { key: "agentCents", label: "代理收益", color: AGENT },
          ]}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="km-panel space-y-3">
          <h3 className="font-semibold">各代理收益</h3>
          <HorizonBars
            rows={(data?.byAgent || []).map((row) => ({
              label: row.agentName,
              value: row.agentCents,
            }))}
            valueKey="value"
            labelKey="label"
            color={AGENT}
          />
        </section>
        <section className="km-panel space-y-3">
          <h3 className="font-semibold">各套餐销售额</h3>
          <HorizonBars
            rows={(data?.byPlan || []).map((row) => ({
              label: row.label,
              value: row.grossCents,
            }))}
            valueKey="value"
            labelKey="label"
            color={PLATFORM}
          />
        </section>
        <section className="km-panel space-y-3">
          <h3 className="font-semibold">支付渠道</h3>
          <HorizonBars
            rows={(data?.byChannel || []).map((row) => ({
              label: row.label,
              value: row.grossCents,
            }))}
            valueKey="value"
            labelKey="label"
            color={FEE}
          />
        </section>
        <section className="km-panel space-y-3">
          <h3 className="font-semibold">手续费核对</h3>
          <HorizonBars
            rows={(data?.byFee || []).map((row) => ({
              label: row.label,
              value: row.feeCents,
            }))}
            valueKey="value"
            labelKey="label"
            color={FEE}
          />
        </section>
      </div>

      {data?.byAgent.length ? (
        <section className="km-panel space-y-3">
          <h3 className="font-semibold">代理明细</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)]">
                  <th className="py-2 pr-3">代理</th>
                  <th className="py-2 pr-3">单量</th>
                  <th className="py-2 pr-3">销售额</th>
                  <th className="py-2 pr-3">平台收益</th>
                  <th className="py-2 pr-3">代理收益</th>
                  <th className="py-2 pr-3">待结算</th>
                  <th className="py-2">已返佣</th>
                </tr>
              </thead>
              <tbody>
                {data.byAgent.map((row) => (
                  <tr key={row.agentId} className="border-b border-[var(--km-border)]">
                    <td className="py-2 pr-3">{row.agentName}</td>
                    <td className="py-2 pr-3">{row.orderCount}</td>
                    <td className="py-2 pr-3">{yuan(row.grossCents)}</td>
                    <td className="py-2 pr-3">{yuan(row.platformCents)}</td>
                    <td className="py-2 pr-3">{yuan(row.agentCents)}</td>
                    <td className="py-2 pr-3">{yuan(row.pendingCents)}</td>
                    <td className="py-2">{yuan(row.settledCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
