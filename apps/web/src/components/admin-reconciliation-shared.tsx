"use client";

import type { ReactNode } from "react";
import {
  errorView,
  formatBeijing,
  formatFormula,
  formatSignedYuan,
  formatYuan,
  itemTypeLabel,
  netEffectCents,
  statusLabel,
  type Breakdown,
  type ErrorAction,
  type ErrorStage,
  type ErrorView,
  type ReconDirection,
} from "@/lib/admin-reconciliation-ui";

/* ---------- 与后端严格对齐的响应类型 ---------- */

/** GET /api/admin/reconciliations/agents → data.list[] */
export type AgentRow = {
  agentId: number;
  name: string;
  storeEarningCents: number;
  adjustmentCents: number;
  drawDebtCents: number;
  netCents: number;
  direction: ReconDirection;
  itemCount: number;
  skippedCount: number;
  lockedNetCents: number;
  latestBatch: { id: number; batchNo: string; status: string; netCents: number } | null;
  updatedAt: string;
};

export type AgentListData = {
  cutoffAt: string;
  currency: "CNY";
  summary: { openAgents: number; platformPaysCents: number; agentPaysCents: number; reviewOrders: number };
  list: AgentRow[];
  nextCursor: string | null;
};

export type PreviewItem = { type: string; id: number; version: string; amountCents: number; orderNo: string };
export type SkippedItem = { orderNo: string; code?: string; message?: string; amountCents: number | null };

/** GET /api/admin/reconciliations/agents/:agentId/preview → data */
export type Preview = {
  agentId: number;
  currency: "CNY";
  cutoffAt: string;
  previewVersion: string;
  totals: Breakdown & { direction: ReconDirection };
  /** 锁定合计 = lockedInBatch + lockedLegacy。 */
  locked: { netCents: number; storeEarningCents: number; adjustmentCents: number; drawDebtCents: number; itemCount: number };
  /** 以下两项是新后端字段，旧后端没有，读取时必须容错。 */
  lockedInBatch?: {
    itemCount: number;
    netCents: number;
    storeEarningCents: number;
    adjustmentCents: number;
    drawDebtCents: number;
    batchIds: number[];
  };
  lockedLegacy?: {
    itemCount: number;
    netCents: number;
    storeEarningCents: number;
    adjustmentCents: number;
    settlementNos: string[];
  };
  skipped: SkippedItem[];
  skippedUnknownCount: number;
  items: PreviewItem[];
  note: string;
};

/** agent_reconciliation_batches 整行（GET /:id 与 batches 列表都返回它）。 */
export type BatchRow = {
  id: number;
  batchNo: string;
  agentId: number;
  cutoffAt: string;
  periodLabel: string;
  currency: string;
  storeEarningCents: number;
  adjustmentCents: number;
  drawDebtCents: number;
  netCents: number;
  storeCount: number;
  adjustmentCount: number;
  drawCount: number;
  direction: string;
  status: string;
  snapshotHash: string;
  version: number;
  createdBy: number;
  createdAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  paymentMethod: string;
  paymentReference: string;
  paymentNote: string;
  actualPaymentAt: string | null;
};

export type AuditRow = {
  id: number;
  action: string;
  actorRole: string;
  ip: string;
  createdAt: string;
  metadata: { before?: unknown; after?: unknown; sourceBatchId?: number } & Record<string, unknown>;
};

export type BatchDetail = BatchRow & { audits: AuditRow[] };

/** GET /api/admin/reconciliations/agents/:agentId/batches → data */
export type BatchListData = { list: BatchRow[]; nextCursor: number | null };

export type BatchItem = {
  id: number;
  batchId: number;
  agentId: number;
  sourceType: string;
  sourceId: number;
  sourceVersion: string;
  amountCents: number;
  direction: string;
  sourceOrderNo: string;
  snapshotJson: string;
  createdAt: string;
  snapshot: Record<string, unknown>;
};

/** GET /api/admin/reconciliations/:id/items → data */
export type BatchItemsData = { batchNo: string; snapshotHash: string; items: BatchItem[]; nextCursor: number | null };

/* ---------- 请求 ---------- */

export type ApiResult<T> =
  | { ok: true; status: number; data: T; requestId: string }
  | { ok: false; status: number; code: string; message: string; retryable: boolean; requestId: string };

const TIMEOUT_MS = 20000;

/** 统一解包 {data, requestId} / {error:{code,message,retryable}, requestId}。status=0 表示网络中断或超时。 */
export async function apiCall<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
  } catch {
    window.clearTimeout(timer);
    return { ok: false, status: 0, code: "NETWORK", message: "", retryable: true, requestId: "" };
  }
  window.clearTimeout(timer);
  const body = (await response.json().catch(() => null)) as
    | { data?: T; requestId?: string; error?: { code?: string; message?: string; retryable?: boolean } | string }
    | null;
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  if (response.ok && body && "data" in body) {
    return { ok: true, status: response.status, data: body.data as T, requestId };
  }
  const error = body?.error;
  if (error && typeof error === "object") {
    return {
      ok: false,
      status: response.status,
      code: error.code || "",
      message: error.message || "",
      retryable: Boolean(error.retryable),
      requestId,
    };
  }
  // requireAdmin 返回 {error:"unauthorized"|"forbidden"}，其它情况视为系统错误。
  const code = error === "unauthorized" ? "UNAUTHORIZED" : error === "forbidden" ? "FORBIDDEN" : "";
  return {
    ok: false,
    status: response.ok ? 500 : response.status,
    code,
    message: "",
    retryable: false,
    requestId,
  };
}

export function viewOf(result: Extract<ApiResult<unknown>, { ok: false }>, stage: ErrorStage): ErrorView {
  return errorView({
    status: result.status,
    code: result.code,
    message: result.message,
    requestId: result.requestId,
    stage,
  });
}

/* ---------- 展示组件 ---------- */

export type Notice = { kind: "ok" | "err" | "info"; text: string; detail?: string; action?: ErrorAction };

export function NoticeBar({
  notice,
  actionLabel,
  onAction,
  onClose,
}: {
  notice: Notice;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
}) {
  const tone =
    notice.kind === "err"
      ? "border-[var(--km-danger)] text-[var(--km-danger)]"
      : notice.kind === "ok"
        ? "border-[var(--km-success)]"
        : "border-[var(--km-border)]";
  return (
    <div role={notice.kind === "err" ? "alert" : "status"} className={`km-panel flex flex-wrap items-center gap-3 border text-sm ${tone}`}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{notice.text}</p>
        {notice.detail ? <p className="mt-1 text-xs text-[var(--km-fg-muted)]">后端说明：{notice.detail}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <button type="button" className="km-btn km-btn-sm" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={onClose} aria-label="关闭提示">
        关闭
      </button>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "paid" || status === "cleared" || status === "corrected"
      ? "km-badge-ok"
      : status === "cancelled"
        ? ""
        : status === "correction_pending"
          ? "km-badge-bad"
          : "km-badge-wait";
  return <span className={`km-badge ${tone}`}>{statusLabel(status)}</span>;
}

/** 净额：方向文案 + 绝对值，永不出现负号。 */
export function NetText({ netCents, className = "" }: { netCents: number; className?: string }) {
  const tone = netCents > 0 ? "text-[var(--km-accent)]" : netCents < 0 ? "text-[var(--km-warning)]" : "";
  const label = netCents > 0 ? "平台应付代理" : netCents < 0 ? "代理应付平台" : "抵平";
  return (
    <span className={`whitespace-nowrap font-semibold ${tone} ${className}`}>
      {label} {formatYuan(netCents)}
    </span>
  );
}

export function Formula({ value, className = "" }: { value: Breakdown; className?: string }) {
  return <p className={`text-sm leading-6 ${className}`}>{formatFormula(value)}</p>;
}

export type DisplayLine = {
  key: string;
  type: string;
  orderNo: string;
  amountCents: number;
  detail?: string;
  occurredAt?: string;
};

/** 明细表：净额影响列放在最前，提卡按代理欠款显示为负向。 */
export function LinesTable({ lines, extra }: { lines: DisplayLine[]; extra?: (line: DisplayLine) => ReactNode }) {
  if (!lines.length) return <p className="py-3 text-sm text-[var(--km-fg-muted)]">这一类没有明细。</p>;
  const showTime = lines.some((line) => line.occurredAt);
  const showDetail = lines.some((line) => line.detail);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-xs">
        <thead>
          <tr className="text-[var(--km-fg-muted)]">
            <th className="py-1 pr-3">对净额影响</th>
            <th className="py-1 pr-3">类型</th>
            <th className="py-1 pr-3">单号</th>
            {showDetail ? <th className="py-1 pr-3">说明</th> : null}
            {showTime ? <th className="py-1 pr-3">发生时间（北京）</th> : null}
            {extra ? <th className="py-1">操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const effect = netEffectCents(line.type, line.amountCents);
            return (
              <tr key={line.key} className="border-t border-[var(--km-border)]">
                <td className="whitespace-nowrap py-2 pr-3 font-semibold">
                  {formatSignedYuan(effect)}
                  {line.type === "draw_item" ? <span className="ml-1 font-normal text-[var(--km-fg-muted)]">代理欠</span> : null}
                </td>
                <td className="whitespace-nowrap py-2 pr-3">{itemTypeLabel(line.type)}</td>
                <td className="py-2 pr-3 font-mono">{line.orderNo || "—"}</td>
                {showDetail ? <td className="py-2 pr-3 text-[var(--km-fg-muted)]">{line.detail || ""}</td> : null}
                {showTime ? (
                  <td className="whitespace-nowrap py-2 pr-3">{line.occurredAt ? formatBeijing(line.occurredAt) : "—"}</td>
                ) : null}
                {extra ? <td className="py-2">{extra(line)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const TYPE_FILTERS = [
  { value: "", label: "全部" },
  { value: "earning", label: "商店收益" },
  { value: "adjustment", label: "调整" },
  { value: "draw_item", label: "提卡" },
] as const;

export function TypeTabs({ value, onChange, counts }: { value: string; onChange: (value: string) => void; counts?: Record<string, number> }) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="明细类型">
      {TYPE_FILTERS.map((item) => (
        <button
          key={item.value || "all"}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          className={`km-btn km-btn-sm ${value === item.value ? "" : "km-btn-ghost"}`}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {counts && counts[item.value] !== undefined ? ` ${counts[item.value]}` : ""}
        </button>
      ))}
    </div>
  );
}
