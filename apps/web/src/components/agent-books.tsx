"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/toast";
import type { UsageStatsPayload } from "@/components/usage-stats-panel";
import {
  agentEarningsQuery,
  beijingRangeYmd,
  legacySettlementStatusLabel,
  moneyYuanAbs,
  netDirectionLabel,
  netDirectionText,
  paymentMethodLabel,
  reconciliationStatusLabel,
  signedMoneyYuan,
  type AgentRangeKey,
} from "@/lib/agent-console-core";
import { copyText } from "@/lib/copy-text";
import { formatBeijingDateTime } from "@/lib/datetime";
import { readApiJson } from "@/lib/http-error";
import { publicStatusLabel } from "@/lib/status-labels";

/* ---------- 接口形状（只列页面用到的字段） ---------- */

type PeriodRow = {
  id: number;
  confirmedAt: string;
  orderNo: string;
  productName: string;
  grossCents: number;
  agentCostCents?: number;
  totalFeeCents: number;
  agentFeeCents: number;
  earningCents: number;
  earningStatus?: string;
  feeReconcileStatus?: string;
  listGoodsCents?: number;
  couponDiscountCents?: number;
};

type PeriodPayload = {
  start: string;
  end: string;
  summary: {
    orderCount: number;
    grossCents: number;
    totalFeeCents: number;
    agentFeeCents: number;
    earningCents: number;
    reversedCents?: number;
    reversedCount?: number;
    pendingCents: number;
  };
  list: PeriodRow[];
  nextCursor: number | null;
};

type Unsettled = {
  cutoffAt: string;
  note?: string;
  totals: {
    netCents: number;
    storeEarningCents: number;
    adjustmentCents: number;
    drawDebtCents: number;
  };
  items?: unknown[];
  skipped?: Array<{ orderNo: string; code?: string; message?: string; amountCents: number | null }>;
  skippedUnknownCount?: number;
  locked?: { itemCount: number; netCents: number };
  lockedInBatch?: { itemCount: number; netCents: number; batchIds?: number[] };
  lockedLegacy?: { itemCount: number; netCents: number; settlementNos?: string[] };
};

type Batch = {
  id: number;
  batchNo: string;
  status: string;
  cutoffAt: string;
  createdAt: string;
  netCents: number;
  storeEarningCents: number;
  adjustmentCents: number;
  drawDebtCents: number;
  storeCount?: number;
  adjustmentCount?: number;
  drawCount?: number;
  paymentMethod?: string;
  paymentReference?: string;
  paidAt?: string | null;
  actualPaymentAt?: string | null;
};

type BatchItem = {
  id: number;
  sourceType: string;
  sourceOrderNo: string;
  amountCents: number;
  snapshot?: Record<string, unknown>;
};

type LegacySettlement = {
  id: number;
  settlementNo: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  status: string;
};

/* ---------- 加载工具：每个数据源各自 loading / error / ok ---------- */

type Loadable<T> = { status: "loading" } | { status: "error" } | { status: "ok"; data: T };

async function getJson<T>(url: string): Promise<T> {
  const body = await readApiJson<Record<string, unknown>>(await fetch(url, { cache: "no-store" }));
  return ("data" in body ? body.data : body) as T;
}

function withCursor(url: string, cursor: number) {
  return `${url}${url.includes("?") ? "&" : "?"}cursor=${cursor}`;
}

function useLoad<T>(url: string | null) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState({ status: "loading" });
    getJson<T>(url).then(
      (data) => {
        if (!cancelled) setState({ status: "ok", data });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return [state, reload] as const;
}

type Paged<T, D> = {
  status: "loading" | "error" | "ok";
  first: D | null;
  rows: T[];
  next: number | null;
  more: "idle" | "loading" | "error";
};

type PagedApi<T, D> = { state: Paged<T, D>; reload: () => void; loadMore: () => Promise<void> };

function usePaged<T, D>(url: string, listKey: "list" | "items"): PagedApi<T, D> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Paged<T, D>>({
    status: "loading",
    first: null,
    rows: [],
    next: null,
    more: "idle",
  });
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
    let cancelled = false;
    setState({ status: "loading", first: null, rows: [], next: null, more: "idle" });
    getJson<D>(withCursor(url, 0)).then(
      (data) => {
        if (cancelled) return;
        const page = data as Record<string, unknown>;
        setState({
          status: "ok",
          first: data,
          rows: (page[listKey] as T[]) || [],
          next: (page.nextCursor as number | null) ?? null,
          more: "idle",
        });
      },
      () => {
        if (!cancelled) setState((s) => ({ ...s, status: "error" }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, listKey, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const next = state.next;
  const loadMore = useCallback(async () => {
    if (next === null) return;
    const requested = url;
    setState((s) => ({ ...s, more: "loading" }));
    try {
      const page = (await getJson<D>(withCursor(url, next))) as Record<string, unknown>;
      if (urlRef.current !== requested) return;
      setState((s) => ({
        ...s,
        rows: [...s.rows, ...((page[listKey] as T[]) || [])],
        next: (page.nextCursor as number | null) ?? null,
        more: "idle",
      }));
    } catch {
      if (urlRef.current === requested) setState((s) => ({ ...s, more: "error" }));
    }
  }, [url, listKey, next]);
  return { state, reload, loadMore };
}

/* ---------- 小组件 ---------- */

function Retry({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" className="km-books-retry" onClick={onRetry}>
      加载失败，点此重试
    </button>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--km-fg-muted)]">{children}</p>;
}

function MoreButton({ more, onMore }: { more: "idle" | "loading" | "error"; onMore: () => void }) {
  return (
    <button type="button" className="km-btn km-btn-ghost km-books-more" disabled={more === "loading"} onClick={onMore}>
      {more === "loading" ? "加载中…" : more === "error" ? "加载失败，点此重试" : "加载更多"}
    </button>
  );
}

function bj(value: unknown) {
  return formatBeijingDateTime(value) || "—";
}

async function copyBatchNo(batchNo: string) {
  try {
    await copyText(batchNo);
    toast(`已复制 ${batchNo}`);
  } catch {
    toast("复制失败，请手动复制", "err");
  }
}

function breakdownText(store: number, adjustment: number, draw: number) {
  return `商店 ${signedMoneyYuan(store)} ＋ 调整 ${signedMoneyYuan(adjustment)} − 提卡 ${moneyYuanAbs(draw)}`;
}

const RANGES: Array<[AgentRangeKey, string]> = [
  ["today", "今天"],
  ["7d", "近 7 天"],
  ["month", "本月"],
  ["all", "全部"],
];

const OPEN_BATCH_STATUSES = new Set(["draft", "pending_payment"]);

/* ---------- 页面 ---------- */

export function AgentBooks() {
  const [range, setRange] = useState<AgentRangeKey>("7d");
  const { start, end } = useMemo(() => beijingRangeYmd(range), [range]);
  const [unsettled, reloadUnsettled] = useLoad<Unsettled>("/api/agent/ledger/unsettled");
  const batches = usePaged<Batch, { list: Batch[] }>("/api/agent/reconciliations?limit=20", "list");
  const period = usePaged<PeriodRow, PeriodPayload>(
    `/api/agent/ledger/period?start=${start}&end=${end}&limit=20`,
    "list",
  );
  const [usage, reloadUsage] = useLoad<UsageStatsPayload>(`/api/agent/usage/stats?start=${start}&end=${end}`);
  const [openBatchId, setOpenBatchId] = useState<number | null>(null);

  function jumpToBatch(id: number) {
    setOpenBatchId(id);
    requestAnimationFrame(() => {
      document.getElementById(`km-batch-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>账本</h1>
          <p>上面是累计未结和对账批次，和平台看到的是同一个数；下面的日期只筛经营统计和成交明细。时间均为北京时间。</p>
        </div>
      </header>

      <UnsettledPanel
        state={unsettled}
        onRetry={reloadUnsettled}
        loadedBatches={batches.state.rows}
        onOpenBatch={jumpToBatch}
      />

      <BatchesPanel paged={batches} openId={openBatchId} onToggle={(id) => setOpenBatchId((cur) => (cur === id ? null : id))} />

      <LegacySettlements />

      <section className="km-panel">
        <div className="km-acp-section-title km-books-period-head">
          <div>
            <h2>经营统计</h2>
            <p>只影响下方经营统计和成交明细，不影响上方累计未结。</p>
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
        </div>
        <PeriodKpis state={period.state} onRetry={period.reload} usage={usage} onRetryUsage={reloadUsage} />
      </section>

      <section className="km-panel">
        <div className="km-acp-section-title">
          <div>
            <h2>这段时间的单</h2>
            <p>下单、已付、未兑放在账本里，一眼能对上钱。</p>
          </div>
        </div>
        {usage.status === "loading" ? <Muted>加载中…</Muted> : null}
        {usage.status === "error" ? <Retry onRetry={reloadUsage} /> : null}
        {usage.status === "ok" ? (
          <div className="km-acp-kpis km-books-kpis">
            <div className="km-acp-kpi">
              <span>下单</span>
              <strong>{usage.data.orders.placed}</strong>
            </div>
            <div className="km-acp-kpi">
              <span>已付</span>
              <strong>{usage.data.orders.paid}</strong>
            </div>
            <div className="km-acp-kpi">
              <span>已发齐</span>
              <strong>{usage.data.orders.delivered}</strong>
            </div>
            <div className="km-acp-kpi">
              <span>未兑换</span>
              <strong>{usage.data.cdks.unusedBacklog}</strong>
              <small>当前积压，不只看这一段</small>
            </div>
          </div>
        ) : null}
      </section>

      <PeriodDetail paged={period} />
    </>
  );
}

/* ---------- 累计未结 ---------- */

function UnsettledPanel({
  state,
  onRetry,
  loadedBatches,
  onOpenBatch,
}: {
  state: Loadable<Unsettled>;
  onRetry: () => void;
  loadedBatches: Batch[];
  onOpenBatch: (id: number) => void;
}) {
  const data = state.status === "ok" ? state.data : null;
  const totals = data?.totals;
  const inBatch = data?.lockedInBatch;
  const legacy = data?.lockedLegacy;
  // 新字段缺失（旧后端）时回退到合计 locked，且不出现批次链接。
  const hasSplitLocked = Boolean(inBatch?.itemCount || legacy?.itemCount);
  // 只按 batchIds 在已加载的批次里精确匹配，匹配不到就不指向任何批次。
  const batchIds = new Set(inBatch?.batchIds || []);
  const matchedBatches = loadedBatches.filter((batch) => batchIds.has(batch.id));
  const skipped = data?.skipped || [];
  const skippedKnown = skipped.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
  const skippedUnknown = skipped.filter((row) => row.amountCents === null).length;
  return (
    <section className="km-panel">
      <div className="km-acp-section-title">
        <div>
          <h2>累计未结</h2>
          <p>
            {data ? `截止 ${bj(data.cutoffAt)}（北京时间）· ` : ""}
            从上次结算累到现在，这里不受下方日期筛选影响。
          </p>
        </div>
        {totals ? <span className="km-acp-pill">{netDirectionLabel(totals.netCents)}</span> : null}
      </div>
      {state.status === "loading" ? <Muted>加载中…</Muted> : null}
      {state.status === "error" ? <Retry onRetry={onRetry} /> : null}
      {totals ? (
        <>
          <p className="km-books-equation">
            商店收益 {signedMoneyYuan(totals.storeEarningCents)} ＋ 调整 {signedMoneyYuan(totals.adjustmentCents)} −
            提卡欠款 {moneyYuanAbs(totals.drawDebtCents)} ＝ <b>{netDirectionText(totals.netCents)}</b>
          </p>
          <div className="km-acp-kpis km-books-kpis">
            <div className="km-acp-kpi">
              <span>{netDirectionLabel(totals.netCents)}</span>
              <strong>{moneyYuanAbs(totals.netCents)}</strong>
              <small>{data?.note || "可对账净额，不含待核对项"}</small>
            </div>
            <div className="km-acp-kpi">
              <span>商店收益</span>
              <strong>{signedMoneyYuan(totals.storeEarningCents)}</strong>
              <small>平台要转给我的</small>
            </div>
            <div className="km-acp-kpi">
              <span>调整</span>
              <strong>{signedMoneyYuan(totals.adjustmentCents)}</strong>
              <small>退款、手续费更正等，负数为扣减</small>
            </div>
            <div className="km-acp-kpi">
              <span>提卡欠款</span>
              <strong>{moneyYuanAbs(totals.drawDebtCents)}</strong>
              <small>我要转给平台的</small>
            </div>
          </div>
          {hasSplitLocked ? (
            <>
              {inBatch?.itemCount ? (
                <p className="km-books-note">
                  另有 {inBatch.itemCount} 笔、{netDirectionText(inBatch.netCents)} 在对账批次
                  {matchedBatches.length ? (
                    <>
                      {matchedBatches.map((batch, index) => (
                        <span key={batch.id}>
                          {index ? "、" : " "}
                          <button type="button" className="km-books-link" onClick={() => onOpenBatch(batch.id)}>
                            {batch.batchNo}
                          </button>
                        </span>
                      ))}{" "}
                    </>
                  ) : (
                    " "
                  )}
                  中待处理。
                </p>
              ) : null}
              {legacy?.itemCount ? (
                <p className="km-books-note">
                  另有 {legacy.itemCount} 笔、{netDirectionText(legacy.netCents)} 在旧周结单中，平台核验后会进入对账。
                </p>
              ) : null}
            </>
          ) : data?.locked?.itemCount ? (
            <p className="km-books-note">
              另有 {data.locked.itemCount} 笔、{netDirectionText(data.locked.netCents)} 已在未付款的结算单中，等平台处理。
            </p>
          ) : null}
          {skipped.length ? (
            <details className="km-books-note">
              <summary>
                另有 {skipped.length} 笔待核对，不进这次：已知金额 {signedMoneyYuan(skippedKnown)}
                {skippedUnknown ? `，另有 ${skippedUnknown} 笔金额未知` : ""}
              </summary>
              <ul className="km-books-skipped">
                {skipped.map((row, index) => (
                  <li key={`${row.orderNo}-${index}`}>
                    <span>{row.orderNo}</span>
                    <span>{row.message || row.code || "待核对"}</span>
                    <b>{row.amountCents === null ? "金额未知" : signedMoneyYuan(row.amountCents)}</b>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/* ---------- 对账批次（结算历史） ---------- */

function BatchesPanel({
  paged,
  openId,
  onToggle,
}: {
  paged: PagedApi<Batch, { list: Batch[] }>;
  openId: number | null;
  onToggle: (id: number) => void;
}) {
  const { state } = paged;
  return (
    <section className="km-panel">
      <div className="km-acp-section-title">
        <div>
          <h2>结算历史</h2>
          <p>每次对账生成一个批次，金额固定不变。点开看明细；有疑问复制批次号联系平台。</p>
        </div>
      </div>
      {state.status === "loading" ? <Muted>加载中…</Muted> : null}
      {state.status === "error" ? <Retry onRetry={paged.reload} /> : null}
      {state.status === "ok" && !state.rows.length ? <Muted>还没有对账批次。</Muted> : null}
      {state.rows.length ? (
        <div className="km-acp-list">
          {state.rows.map((batch) => (
            <div key={batch.id} id={`km-batch-${batch.id}`} className="km-books-batch">
              <div className="km-books-batch-head">
                <button
                  type="button"
                  className="km-books-batch-toggle"
                  aria-expanded={openId === batch.id}
                  onClick={() => onToggle(batch.id)}
                >
                  <span className="km-books-batch-main">
                    <b>{batch.batchNo}</b>
                    <span>生成于 {bj(batch.createdAt)}</span>
                  </span>
                  <span className="km-books-batch-amount">
                    <b>{netDirectionText(batch.netCents)}</b>
                    <span>{breakdownText(batch.storeEarningCents, batch.adjustmentCents, batch.drawDebtCents)}</span>
                  </span>
                </button>
                <div className="km-books-batch-side">
                  <span className={OPEN_BATCH_STATUSES.has(batch.status) ? "km-acp-pill warn" : "km-acp-pill"}>
                    {reconciliationStatusLabel(batch.status)}
                  </span>
                  <button type="button" className="km-books-link" onClick={() => void copyBatchNo(batch.batchNo)}>
                    复制批次号
                  </button>
                </div>
              </div>
              {openId === batch.id ? <BatchDetail batch={batch} /> : null}
            </div>
          ))}
          {state.next !== null ? <MoreButton more={state.more} onMore={() => void paged.loadMore()} /> : null}
        </div>
      ) : null}
    </section>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  earning: "商店收益",
  adjustment: "调整",
  draw_item: "提卡欠款",
};

function BatchDetail({ batch }: { batch: Batch }) {
  const items = usePaged<BatchItem, { items: BatchItem[] }>(
    `/api/agent/reconciliations/${batch.id}/items?limit=50`,
    "items",
  );
  const { state } = items;
  return (
    <div className="km-books-batch-body">
      <dl className="km-books-meta">
        <div>
          <dt>截止</dt>
          <dd>{bj(batch.cutoffAt)}</dd>
        </div>
        <div>
          <dt>笔数</dt>
          <dd>
            商店 {batch.storeCount ?? "—"} · 调整 {batch.adjustmentCount ?? "—"} · 提卡 {batch.drawCount ?? "—"}
          </dd>
        </div>
        {batch.paymentReference ? (
          <div>
            <dt>付款流水</dt>
            <dd>
              {batch.paymentMethod ? `${paymentMethodLabel(batch.paymentMethod)} · ` : ""}
              {batch.paymentReference}
            </dd>
          </div>
        ) : null}
        {batch.status === "cleared" ? null : (
          <div>
            <dt>付款时间</dt>
            <dd>{bj(batch.actualPaymentAt)}</dd>
          </div>
        )}
        <div>
          <dt>{batch.status === "cleared" ? "结清时间" : "登记时间"}</dt>
          <dd>{bj(batch.paidAt)}</dd>
        </div>
      </dl>
      {state.status === "loading" ? <Muted>明细加载中…</Muted> : null}
      {state.status === "error" ? <Retry onRetry={items.reload} /> : null}
      {state.status === "ok" && !state.rows.length ? <Muted>这个批次没有明细。</Muted> : null}
      {state.rows.length ? (
        <ul className="km-books-items">
          {state.rows.map((item) => {
            const name = typeof item.snapshot?.productName === "string" ? item.snapshot.productName : "";
            const at = item.snapshot?.occurredAt;
            return (
              <li key={item.id}>
                <span className="km-books-item-type">{SOURCE_LABELS[item.sourceType] || item.sourceType}</span>
                <span className="km-books-item-main">
                  <b>{item.sourceOrderNo || "—"}</b>
                  <span>
                    {name ? `${name} · ` : ""}
                    {at ? bj(at) : ""}
                  </span>
                </span>
                <b className="km-books-item-amount">
                  {/* 提卡明细是正的欠款额，对账里是扣减，统一用有符号格式显示成 −¥ */}
                  {signedMoneyYuan(item.sourceType === "draw_item" ? -Math.abs(item.amountCents) : item.amountCents)}
                </b>
              </li>
            );
          })}
        </ul>
      ) : null}
      {state.next !== null ? <MoreButton more={state.more} onMore={() => void items.loadMore()} /> : null}
    </div>
  );
}

/* ---------- 历史周结（旧） ---------- */

function LegacySettlements() {
  const [opened, setOpened] = useState(false);
  const [state, reload] = useLoad<{ list?: LegacySettlement[] }>(opened ? "/api/agent/settlements" : null);
  const list = state.status === "ok" ? state.data.list || [] : [];
  return (
    <details className="km-panel km-books-legacy" onToggle={(event) => setOpened(opened || event.currentTarget.open)}>
      <summary>历史周结（旧）</summary>
      <p className="mt-2 text-xs text-[var(--km-fg-muted)]">对账批次上线前的按周返佣记录，只读。新的结算看上方「结算历史」。</p>
      <div className="km-acp-list mt-3">
        {state.status === "loading" ? <Muted>加载中…</Muted> : null}
        {state.status === "error" ? <Retry onRetry={reload} /> : null}
        {state.status === "ok" && !list.length ? <Muted>没有旧周结记录。</Muted> : null}
        {list.map((item) => (
          <div key={item.id} className="km-acp-row">
            <div>
              <b>{item.settlementNo}</b>
              <span>
                {bj(item.periodStart)} 至 {bj(item.periodEnd)}
              </span>
            </div>
            <div className="text-right">
              <b>{signedMoneyYuan(item.amountCents)}</b>
              <span className="km-acp-pill">{legacySettlementStatusLabel(item.status)}</span>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

/* ---------- 期间统计 ---------- */

function PeriodKpis({
  state,
  onRetry,
  usage,
  onRetryUsage,
}: {
  state: Paged<PeriodRow, PeriodPayload>;
  onRetry: () => void;
  usage: Loadable<UsageStatsPayload>;
  onRetryUsage: () => void;
}) {
  if (state.status === "loading") return <Muted>加载中…</Muted>;
  if (state.status === "error" || !state.first) return <Retry onRetry={onRetry} />;
  const summary = state.first.summary;
  const couponOff =
    usage.status === "ok" ? usage.data.coupons.reduce((sum, item) => sum + item.discountPaidCents, 0) : 0;
  return (
    <div className="km-acp-kpis km-books-kpis">
      <div className="km-acp-kpi">
        <span>成交额</span>
        <strong>{moneyYuanAbs(summary.grossCents)}</strong>
        <small>{summary.orderCount} 笔</small>
      </div>
      <div className="km-acp-kpi">
        <span>代理收益</span>
        <strong>{signedMoneyYuan(summary.earningCents)}</strong>
        <small>
          {summary.reversedCount
            ? `另有 ${summary.reversedCount} 笔已冲回 ${moneyYuanAbs(summary.reversedCents || 0)}，不计入`
            : "不含已退款冲回"}
        </small>
      </div>
      <div className="km-acp-kpi">
        <span>代理承担手续费</span>
        <strong>{moneyYuanAbs(summary.agentFeeCents)}</strong>
        <small>通道总手续费 {moneyYuanAbs(summary.totalFeeCents)}（含平台承担）</small>
      </div>
      <div className="km-acp-kpi">
        <span>本期内未结（参考）</span>
        <strong>{signedMoneyYuan(summary.pendingCents)}</strong>
        <small>以上方累计未结为准</small>
      </div>
      <div className="km-acp-kpi">
        <span>券减免</span>
        {usage.status === "ok" ? <strong>{moneyYuanAbs(couponOff)}</strong> : null}
        {usage.status === "loading" ? <strong>…</strong> : null}
        {usage.status === "error" ? <Retry onRetry={onRetryUsage} /> : null}
      </div>
    </div>
  );
}

function PeriodDetail({ paged }: { paged: PagedApi<PeriodRow, PeriodPayload> }) {
  const { state } = paged;
  return (
    <section className="km-panel space-y-4">
      <div className="km-acp-section-title">
        <div>
          <h2>成交明细</h2>
          <p>收益 = 实付 − 代理成本 − 代理承担手续费。开票加价、平台承担手续费归平台，不计入收益。</p>
        </div>
      </div>
      {state.status === "loading" ? <Muted>加载中…</Muted> : null}
      {state.status === "error" ? <Retry onRetry={paged.reload} /> : null}
      {state.status === "ok" && !state.rows.length ? <Muted>这段时间没有成交。</Muted> : null}
      {state.rows.length ? (
        <>
          <div className="km-books-table overflow-x-auto">
            <table className="km-acp-price">
              <thead>
                <tr>
                  <th>时间（北京）</th>
                  <th>订单</th>
                  <th>收益</th>
                  <th>套餐</th>
                  <th>实付</th>
                  <th>成本</th>
                  <th>代理承担手续费</th>
                  <th>通道总手续费</th>
                  <th>手续费口径</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((item) => {
                  const reversed = item.earningStatus === "reversed";
                  return (
                    <tr key={item.id} className={reversed ? "km-books-reversed" : undefined}>
                      <td>{bj(item.confirmedAt)}</td>
                      <td>{item.orderNo}</td>
                      <td>
                        <b>{signedMoneyYuan(item.earningCents)}</b>
                        {reversed ? <span className="km-acp-pill mute">已冲回</span> : null}
                      </td>
                      <td>{item.productName}</td>
                      <td
                        title={
                          item.couponDiscountCents
                            ? `挂牌 ${moneyYuanAbs(item.listGoodsCents || item.grossCents)}，优惠 ${moneyYuanAbs(item.couponDiscountCents)}`
                            : undefined
                        }
                      >
                        {moneyYuanAbs(item.grossCents)}
                      </td>
                      <td>{moneyYuanAbs(item.agentCostCents || 0)}</td>
                      <td>{moneyYuanAbs(item.agentFeeCents)}</td>
                      <td>{moneyYuanAbs(item.totalFeeCents)}</td>
                      <td>{publicStatusLabel(item.feeReconcileStatus || "", "fee")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="km-books-cards">
            {state.rows.map((item) => {
              const reversed = item.earningStatus === "reversed";
              return (
                <li key={item.id} className={reversed ? "km-books-reversed" : undefined}>
                  <div className="km-books-card-head">
                    <span>
                      <b>{item.orderNo}</b>
                      <span>{bj(item.confirmedAt)}</span>
                    </span>
                    <span className="km-books-card-earning">
                      <b>{signedMoneyYuan(item.earningCents)}</b>
                      <span>{reversed ? "已冲回，不计入" : "收益"}</span>
                    </span>
                  </div>
                  <details>
                    <summary>成本与手续费</summary>
                    <dl className="km-books-meta">
                      <div>
                        <dt>套餐</dt>
                        <dd>{item.productName}</dd>
                      </div>
                      <div>
                        <dt>实付</dt>
                        <dd>{moneyYuanAbs(item.grossCents)}</dd>
                      </div>
                      {item.couponDiscountCents ? (
                        <div>
                          <dt>券优惠</dt>
                          <dd>{moneyYuanAbs(item.couponDiscountCents)}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>代理成本</dt>
                        <dd>{moneyYuanAbs(item.agentCostCents || 0)}</dd>
                      </div>
                      <div>
                        <dt>代理承担手续费</dt>
                        <dd>{moneyYuanAbs(item.agentFeeCents)}</dd>
                      </div>
                      <div>
                        <dt>通道总手续费</dt>
                        <dd>{moneyYuanAbs(item.totalFeeCents)}</dd>
                      </div>
                      <div>
                        <dt>手续费口径</dt>
                        <dd>{publicStatusLabel(item.feeReconcileStatus || "", "fee")}</dd>
                      </div>
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
          {state.next !== null ? <MoreButton more={state.more} onMore={() => void paged.loadMore()} /> : null}
        </>
      ) : null}
    </section>
  );
}
