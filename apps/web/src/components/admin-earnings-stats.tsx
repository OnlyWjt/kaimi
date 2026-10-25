"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { KmSelect } from "@/components/km-select";
import { readApiJson } from "@/lib/http-error";
import type { StatsGrain } from "@/lib/earnings-stats-core";

type AgentOption = { id: number; displayName: string };

type Money = {
  orderCount: number;
  grossCents: number;
  platformCents: number;
  agentCents: number;
  feeCents: number;
  upstreamCents: number;
  platformFeeCents: number;
  profitCents: number;
  profitUnknownCount: number;
  invoiceCents: number;
  backfillCount: number;
  backfillProfitCents: number;
  refundedOrderCount: number;
  basisCostCents: number;
  basisInvoiceCents: number;
  basisUpstreamCents: number;
  basisPlatformFeeCents: number;
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

type DrawMoney = {
  itemCount: number;
  amountCents: number;
  upstreamCents: number;
  profitCents: number;
  profitUnknownCount: number;
  unsettledCents: number;
  settledCents: number;
  voidCount: number;
};

type PeriodRow = {
  bucket: string;
  label: string;
  storeOrderCount: number;
  storeProfitCents: number;
  storeProfitUnknownCount: number;
  drawItemCount: number;
  drawProfitCents: number;
  drawProfitUnknownCount: number;
  totalProfitCents: number;
};

type StatsPayload = {
  range: { start: string; end: string; grain: StatsGrain };
  totals: Money;
  byAgent: Array<Money & { agentId: number; agentName: string }>;
  series: Array<Money & { bucket: string; label: string }>;
  byChannel: NamedMoney[];
  byPlan: NamedMoney[];
  byFee: NamedMoney[];
  draw: {
    totals: DrawMoney;
    byAgent: Array<DrawMoney & { agentId: number; agentName: string }>;
  };
  periods: PeriodRow[];
  pipeline: Pipeline;
};

const emptyDraw: DrawMoney = {
  itemCount: 0,
  amountCents: 0,
  upstreamCents: 0,
  profitCents: 0,
  profitUnknownCount: 0,
  unsettledCents: 0,
  settledCents: 0,
  voidCount: 0,
};

const emptyMoney: Money = {
  orderCount: 0,
  grossCents: 0,
  platformCents: 0,
  agentCents: 0,
  feeCents: 0,
  upstreamCents: 0,
  platformFeeCents: 0,
  profitCents: 0,
  profitUnknownCount: 0,
  invoiceCents: 0,
  backfillCount: 0,
  backfillProfitCents: 0,
  refundedOrderCount: 0,
  basisCostCents: 0,
  basisInvoiceCents: 0,
  basisUpstreamCents: 0,
  basisPlatformFeeCents: 0,
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

/** 北京日历上的某一天：0 = 今天，-6 = 往前数第 6 天。不看浏览器时区，和统计切天一致。 */
function beijingYmd(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function yuan(cents: number) {
  const value = (Math.abs(cents) / 100).toFixed(2);
  return cents < 0 ? `-¥${value}` : `¥${value}`;
}

type Preset = "today" | "7d" | "30d" | "custom";

const PRESETS: Array<[Preset, string]> = [
  ["today", "今天"],
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
  ["custom", "自定义"],
];

const PLATFORM = "var(--km-fg)";
const AGENT = "var(--km-accent)";
const FEE = "var(--km-fg-muted)";
const STORE = "var(--km-fg)";
const DRAW = "var(--km-warning)";

/** 每个时间段一根柱子：店铺毛利在下、提卡毛利叠在上面。负数按 0 画。 */
function StackedProfitChart({ rows }: { rows: PeriodRow[] }) {
  const points = [...rows].reverse();
  // 跟着面板宽度铺满：7 天也占满一行，天数多了再横向滚动
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  if (!points.some((row) => row.storeProfitCents > 0 || row.drawProfitCents > 0)) {
    return (
      <div ref={box}>
        <p className="py-10 text-center text-sm text-[var(--km-fg-muted)]">这段时间还没有收益</p>
      </div>
    );
  }
  const max = Math.max(
    1,
    ...points.map((row) => Math.max(0, row.storeProfitCents) + Math.max(0, row.drawProfitCents)),
  );
  const slot = points.length > 45 ? 18 : 28;
  const width = Math.max(boxWidth || 560, points.length * slot);
  const height = 240;
  const pad = { top: 16, right: 8, bottom: 40, left: 8 };
  const innerH = height - pad.top - pad.bottom;
  const groupW = (width - pad.left - pad.right) / points.length;
  const barW = Math.min(36, Math.max(6, groupW * 0.5));
  // 柱子多的时候隔几个标一次日期，不然字会叠在一起
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.floor(width / 64)));

  return (
    <div ref={box} className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="实际收益柱状图">
        {points.map((row, index) => {
          const x = pad.left + index * groupW + (groupW - barW) / 2;
          const storeH = (Math.max(0, row.storeProfitCents) / max) * innerH;
          const drawH = (Math.max(0, row.drawProfitCents) / max) * innerH;
          const base = pad.top + innerH;
          const label = row.label.length === 10 ? row.label.slice(5) : row.label;
          return (
            <g key={row.bucket}>
              <title>{`${row.label} 实际收益 ${yuan(row.totalProfitCents)}（店铺 ${yuan(row.storeProfitCents)} · 提卡 ${yuan(row.drawProfitCents)}）`}</title>
              <rect x={x} y={base - storeH} width={barW} height={storeH} fill={STORE} rx="2" />
              <rect x={x} y={base - storeH - drawH} width={barW} height={drawH} fill={DRAW} rx="2" />
              {index % labelEvery === 0 ? (
                <text x={x + barW / 2} y={height - 16} textAnchor="middle" fill="var(--km-fg-muted)" fontSize="11">
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const GRAIN_HEAD: Record<StatsGrain, string> = { day: "日期", week: "周", month: "月份" };

function periodsCsv(rows: PeriodRow[], grain: StatsGrain) {
  const money = (cents: number) => (cents / 100).toFixed(2);
  const lines = [
    [GRAIN_HEAD[grain], "店铺单数", "店铺毛利", "提卡张数", "提卡毛利", "实际收益"].join(","),
    ...rows.map((row) =>
      [
        row.label,
        row.storeOrderCount,
        money(row.storeProfitCents),
        row.drawItemCount,
        money(row.drawProfitCents),
        money(row.totalProfitCents),
      ].join(","),
    ),
  ];
  // 带 BOM，Excel 直接打开中文不乱码
  return `\ufeff${lines.join("\n")}`;
}

function downloadPeriods(rows: PeriodRow[], grain: StatsGrain, range: { start: string; end: string }) {
  const blob = new Blob([periodsCsv(rows, grain)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kaimi-收益明细-${range.start}-${range.end}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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
  const [preset, setPreset] = useState<Preset>("7d");
  const [grain, setGrain] = useState<StatsGrain>("day");
  const [agentId, setAgentId] = useState(0);
  const [start, setStart] = useState(() => beijingYmd(-29));
  const [end, setEnd] = useState(() => beijingYmd());
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [data, setData] = useState<StatsPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => {
    if (preset === "today") return { start: beijingYmd(), end: beijingYmd() };
    if (preset === "7d") return { start: beijingYmd(-6), end: beijingYmd() };
    if (preset === "30d") return { start: beijingYmd(-29), end: beijingYmd() };
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
  const draw = data?.draw.totals || emptyDraw;
  const periods = data?.periods || [];
  const pipeline = data?.pipeline || emptyPipeline;
  const actualCents = totals.profitCents + draw.profitCents;
  const unknownNotes = [
    totals.profitUnknownCount ? `店铺 ${totals.profitUnknownCount} 单未配进价` : "",
    draw.profitUnknownCount ? `提卡 ${draw.profitUnknownCount} 张没有上游成本` : "",
  ].filter(Boolean);
  // 代理明细：店铺和提卡按代理并起来，只提过卡的代理也要出现
  const agentRows = (() => {
    const rows = new Map<number, { agentId: number; agentName: string; store?: Money; draw?: DrawMoney }>();
    for (const row of data?.byAgent || []) rows.set(row.agentId, { agentId: row.agentId, agentName: row.agentName, store: row });
    for (const row of data?.draw.byAgent || []) {
      const current = rows.get(row.agentId);
      if (current) current.draw = row;
      else rows.set(row.agentId, { agentId: row.agentId, agentName: row.agentName, draw: row });
    }
    return Array.from(rows.values()).sort(
      (left, right) =>
        (right.store?.profitCents ?? 0) + (right.draw?.profitCents ?? 0) -
        ((left.store?.profitCents ?? 0) + (left.draw?.profitCents ?? 0)),
    );
  })();
  const avgCents = totals.orderCount ? Math.round(totals.grossCents / totals.orderCount) : 0;
  const profitShare = totals.grossCents
    ? Math.round((totals.profitCents / totals.grossCents) * 100)
    : 0;
  const exportHref = `/api/admin/earnings/export.xlsx?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}${agentId > 0 ? `&agentId=${agentId}` : ""}`;

  return (
    <div className="space-y-6">
      <section className="km-panel space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 md:flex-nowrap">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold">收益统计</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              平台实际收益 = 店铺毛利 + 提卡毛利。店铺毛利 = 代理成本 + 平台开票收入 − 上游进价 − 平台手续费；
              提卡毛利 = 提卡价 − 出卡时的上游成本，按出卡日期算，没结算的也算，作废的不算。没配进价的不计入。
            </p>
          </div>
          <a href={exportHref} className="km-btn km-btn-ghost km-btn-sm shrink-0">
            导出这段 Excel
          </a>
        </div>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map(([id, label]) => (
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
          <KmSelect
            value={agentId ? String(agentId) : ""}
            placeholder="全部代理"
            options={[
              { value: "", label: "全部代理" },
              ...agents.map((agent) => ({ value: String(agent.id), label: agent.displayName })),
            ]}
            onChange={(value) => setAgentId(Number(value))}
          />
        </div>
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
        {busy ? <p className="text-xs text-[var(--km-fg-muted)]">正在汇总…</p> : null}
      </section>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">平台实际收益</p>
          <p className="text-2xl font-semibold">{yuan(actualCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            {unknownNotes.length ? `${unknownNotes.join(" · ")}，未计入` : "店铺毛利 + 提卡毛利"}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">店铺毛利</p>
          <p className="text-2xl font-semibold">{yuan(totals.profitCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            {totals.orderCount} 单 · 毛利率 {profitShare}%
            {totals.backfillCount ? ` · 补录 ${totals.backfillCount} 单未计入` : ""}
            {totals.refundedOrderCount ? ` · 退款 ${totals.refundedOrderCount} 单按 0` : ""}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">提卡毛利</p>
          <p className="text-2xl font-semibold">{yuan(draw.profitCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            {draw.itemCount} 张 · 提卡额 {yuan(draw.amountCents)} · 未结算 {yuan(draw.unsettledCents)}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">代理收益</p>
          <p className="text-2xl font-semibold">{yuan(totals.agentCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            待结算 {yuan(totals.pendingCents)} · 已返佣 {yuan(totals.settledCents)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">店铺销售额</p>
          <p className="text-xl font-semibold">{yuan(totals.grossCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">客单 {yuan(avgCents)}</p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">上游与手续费</p>
          <p className="text-xl font-semibold">{yuan(totals.upstreamCents + draw.upstreamCents + totals.feeCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            上游 {yuan(totals.upstreamCents + draw.upstreamCents)} · 手续费 {yuan(totals.feeCents)}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">已支付未出齐</p>
          <p className="text-xl font-semibold">{pipeline.stuckCount}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">{yuan(pipeline.stuckCents)} 还不能结算</p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">未支付</p>
          <p className="text-xl font-semibold">{pipeline.unpaidCount}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">{yuan(pipeline.unpaidCents)}</p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">退款 / 冲正</p>
          <p className="text-xl font-semibold">{yuan(totals.adjustmentCents)}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            退款 {pipeline.refundedCount} 单 · 冲正 {yuan(totals.reversedCents)}
          </p>
        </div>
        <div className="km-stat space-y-1">
          <p className="text-xs text-[var(--km-fg-muted)]">手续费待核</p>
          <p className="text-xl font-semibold">{pipeline.feeReviewCount + pipeline.feePendingCount}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            待人工 {pipeline.feeReviewCount} · 核对中 {pipeline.feePendingCount}
          </p>
        </div>
      </div>

      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">{grain === "day" ? "每日实际收益" : grain === "week" ? "每周实际收益" : "每月实际收益"}</h3>
          <ChartLegend
            items={[
              { label: "店铺毛利", color: STORE },
              { label: "提卡毛利", color: DRAW },
            ]}
          />
        </div>
        <StackedProfitChart rows={periods} />
      </section>

      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">收益明细</h3>
          <button
            type="button"
            className="km-btn km-btn-ghost km-btn-sm"
            disabled={!periods.length}
            onClick={() => downloadPeriods(periods, grain, range)}
          >
            导出明细 CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="km-table min-w-[640px]">
            <thead>
              <tr>
                <th>{GRAIN_HEAD[grain]}</th>
                <th className="text-right">店铺单数</th>
                <th className="text-right">店铺毛利</th>
                <th className="text-right">提卡张数</th>
                <th className="text-right">提卡毛利</th>
                <th className="text-right">实际收益</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((row) => {
                const empty = !row.storeOrderCount && !row.drawItemCount;
                const unknown = row.storeProfitUnknownCount + row.drawProfitUnknownCount;
                return (
                  <tr key={row.bucket} className={empty ? "text-[var(--km-fg-muted)]" : undefined}>
                    <td className="whitespace-nowrap">{row.label}</td>
                    <td className="text-right tabular-nums">{row.storeOrderCount}</td>
                    <td className="text-right tabular-nums">{yuan(row.storeProfitCents)}</td>
                    <td className="text-right tabular-nums">{row.drawItemCount}</td>
                    <td className="text-right tabular-nums">{yuan(row.drawProfitCents)}</td>
                    <td className="text-right font-semibold tabular-nums" title={unknown ? `${unknown} 笔没有进价，未计入` : undefined}>
                      {yuan(row.totalProfitCents)}
                      {unknown ? <span className="ml-1 text-xs font-normal text-[var(--km-warning)]">*</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {periods.length > 1 ? (
              <tfoot>
                <tr className="font-semibold">
                  <td>合计</td>
                  <td className="text-right tabular-nums">{totals.orderCount}</td>
                  <td className="text-right tabular-nums">{yuan(totals.profitCents)}</td>
                  <td className="text-right tabular-nums">{draw.itemCount}</td>
                  <td className="text-right tabular-nums">{yuan(draw.profitCents)}</td>
                  <td className="text-right tabular-nums">{yuan(actualCents)}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        {periods.some((row) => row.storeProfitUnknownCount + row.drawProfitUnknownCount) ? (
          <p className="text-xs text-[var(--km-fg-muted)]">带 * 的那天有没配进价的单，这部分没算进收益。</p>
        ) : null}
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

      {agentRows.length ? (
        <section className="km-panel space-y-3">
          <h3 className="font-semibold">代理明细</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)]">
                  <th className="py-2 pr-3">代理</th>
                  <th className="py-2 pr-3">单量</th>
                  <th className="py-2 pr-3">销售额</th>
                  <th className="py-2 pr-3">上游进价</th>
                  <th className="py-2 pr-3">店铺毛利</th>
                  <th className="py-2 pr-3">提卡张数</th>
                  <th className="py-2 pr-3">提卡毛利</th>
                  <th className="py-2 pr-3">代理收益</th>
                  <th className="py-2 pr-3">待结算</th>
                  <th className="py-2">已返佣</th>
                </tr>
              </thead>
              <tbody>
                {agentRows.map(({ agentId, agentName, store, draw: drawn }) => (
                  <tr key={agentId} className="border-b border-[var(--km-border)]">
                    <td className="py-2 pr-3">{agentName}</td>
                    <td className="py-2 pr-3">{store?.orderCount ?? 0}</td>
                    <td className="py-2 pr-3">{yuan(store?.grossCents ?? 0)}</td>
                    <td className="py-2 pr-3">{yuan((store?.upstreamCents ?? 0) + (drawn?.upstreamCents ?? 0))}</td>
                    <td className="py-2 pr-3">{yuan(store?.profitCents ?? 0)}</td>
                    <td className="py-2 pr-3">{drawn?.itemCount ?? 0}</td>
                    <td className="py-2 pr-3">{yuan(drawn?.profitCents ?? 0)}</td>
                    <td className="py-2 pr-3">{yuan(store?.agentCents ?? 0)}</td>
                    <td className="py-2 pr-3">{yuan(store?.pendingCents ?? 0)}</td>
                    <td className="py-2">{yuan(store?.settledCents ?? 0)}</td>
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
