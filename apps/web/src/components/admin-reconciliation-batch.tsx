"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AskOptions } from "@/components/ask-dialog";
import {
  apiCall,
  Formula,
  LinesTable,
  NetText,
  StatusBadge,
  TypeTabs,
  type ApiResult,
  type BatchDetail,
  type BatchItem,
  type BatchItemsData,
  type DisplayLine,
} from "@/components/admin-reconciliation-shared";
import {
  auditActionLabel,
  beijingInputToUtcIso,
  beijingInputValue,
  correctionEventKey,
  correctionMissing,
  CORRECTION_TYPES,
  csvExportLinks,
  directionOfNet,
  directionText,
  formatBeijing,
  formatSignedYuan,
  formatYuan,
  isCancellableStatus,
  isCorrectableStatus,
  isPaidAtInFuture,
  PAID_AT_FUTURE_TEXT,
  parseNextSequence,
  parseYuanInput,
  PAYMENT_METHODS,
  paymentMethodLabel,
  statusLabel,
  type CorrectionType,
  type ErrorStage,
} from "@/lib/admin-reconciliation-ui";

export type WriteInput = {
  op: string;
  scope: string;
  url: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  stage: ErrorStage;
};

/** 父组件统一处理幂等键、同步锁、错误提示与「结果未知」后的重载。被锁住时返回 null。 */
export type WriteFn = (input: WriteInput) => Promise<ApiResult<unknown> | null>;

type Ask = (options: AskOptions) => Promise<Record<string, string> | null>;

const PAGE = 50;

/** 窄屏固定在底部的操作栏，md 以上回到正常文档流。 */
const ACTION_BAR =
  "fixed inset-x-0 bottom-0 z-30 border-t border-[var(--km-border)] bg-[var(--km-bg-elevated)] p-3 shadow-[var(--km-shadow)] md:static md:z-auto md:border-0 md:bg-transparent md:p-0 md:shadow-none";

function str(value: unknown) {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function itemDetail(item: BatchItem) {
  const snap = item.snapshot || {};
  if (item.sourceType === "earning") return str(snap.productName);
  if (item.sourceType === "adjustment") {
    const parts = [str(snap.type), snap.sequence ? `#${str(snap.sequence)}` : "", str(snap.reason)].filter(Boolean);
    return parts.join(" ");
  }
  return str(snap.planName);
}

function itemOrderId(item: BatchItem) {
  const value = Number(item.snapshot?.orderId);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** 只有带订单的商店收益/调整行能记更正（与后端 addCorrection 的校验一致）。 */
function correctable(item: BatchItem) {
  return (item.sourceType === "earning" || item.sourceType === "adjustment") && itemOrderId(item) > 0;
}

function adjustTypeOf(type: CorrectionType) {
  return type === "fee_delta" ? "fee_correction" : type;
}

function newUuid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function BatchPanel({
  batch,
  agentName,
  busy,
  write,
  ask,
  onChanged,
  itemsVersion,
}: {
  batch: BatchDetail;
  agentName: string;
  busy: boolean;
  write: WriteFn;
  ask: Ask;
  /** 写成功后由父组件重载批次、列表、预览与历史。 */
  onChanged: (batchId: number) => Promise<void>;
  /** 父组件每次重载批次时 +1，用于刷新明细。 */
  itemsVersion: number;
}) {
  const [type, setType] = useState("");
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [itemsError, setItemsError] = useState("");
  const [itemsLoading, setItemsLoading] = useState(false);
  const [correctionItemId, setCorrectionItemId] = useState(0);

  const loadItems = useCallback(async () => {
    setItemsLoading(true);
    const params = new URLSearchParams({ cursor: String(cursor), limit: String(PAGE) });
    if (type) params.set("type", type);
    const result = await apiCall<BatchItemsData>(`/api/admin/reconciliations/${batch.id}/items?${params}`);
    setItemsLoading(false);
    if (!result.ok) {
      setItemsError(
        result.status === 0 || result.status >= 500
          ? `明细没加载出来，请重试${result.requestId ? `（编号 ${result.requestId}）` : ""}`
          : "明细没加载出来，请刷新",
      );
      return;
    }
    setItemsError("");
    setItems(result.data.items);
    setNextCursor(result.data.nextCursor);
  }, [batch.id, cursor, type]);

  useEffect(() => {
    void loadItems();
  }, [loadItems, itemsVersion]);

  const total =
    type === "earning"
      ? batch.storeCount
      : type === "adjustment"
        ? batch.adjustmentCount
        : type === "draw_item"
          ? batch.drawCount
          : batch.storeCount + batch.adjustmentCount + batch.drawCount;

  const csvLinks = useMemo(
    () =>
      csvExportLinks(batch.id, total).map((link) => ({
        ...link,
        href: type ? `${link.href}&type=${encodeURIComponent(type)}` : link.href,
      })),
    [batch.id, total, type],
  );

  const lines: DisplayLine[] = items.map((item) => ({
    key: `item-${item.id}`,
    type: item.sourceType,
    orderNo: item.sourceOrderNo,
    amountCents: item.amountCents,
    detail: itemDetail(item),
    occurredAt: str(item.snapshot?.occurredAt) || undefined,
  }));
  const byKey = new Map(items.map((item) => [`item-${item.id}`, item]));
  const canCorrect = isCorrectableStatus(batch.status);

  const patchBase = { expectedVersion: batch.version, snapshotHash: batch.snapshotHash };

  async function patch(action: "confirm" | "cancel" | "clear", stage: ErrorStage) {
    const body = { action, ...patchBase };
    const result = await write({
      op: action,
      scope: `batch${batch.id}`,
      url: `/api/admin/reconciliations/${batch.id}`,
      method: "PATCH",
      body,
      stage,
    });
    if (result?.ok) await onChanged(batch.id);
  }

  async function confirmBatch() {
    const answer = await ask({
      title: "确认这批",
      message: `${agentName} ${batch.batchNo}\n${directionText(directionOfNet(batch.netCents))} ${formatYuan(batch.netCents)}\n确认后进入待付款，明细不再变化。`,
      confirmLabel: "确认这批",
    });
    if (answer) await patch("confirm", "batch");
  }

  async function cancelBatch() {
    const answer = await ask({
      title: "取消批次",
      message: `取消 ${batch.batchNo}？\n取消后明细回到未结，可重新生成。`,
      confirmLabel: "取消批次",
      cancelLabel: "不取消",
      danger: true,
    });
    if (answer) await patch("cancel", "batch");
  }

  async function clearBatch() {
    const answer = await ask({
      title: "确认抵平结清",
      message: `${agentName} ${batch.batchNo} 净额为 ¥0.00，确认抵平结清？不登记任何付款。`,
      confirmLabel: "确认抵平结清",
    });
    if (answer) await patch("clear", "payment");
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-2xl border border-[var(--km-border)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-base font-semibold">{batch.batchNo}</h3>
          <StatusBadge status={batch.status} />
        </div>
        <NetText netCents={batch.netCents} className="block text-xl" />
        <Formula value={batch} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--km-fg-muted)] sm:grid-cols-4">
          <div>
            <dt>截止</dt>
            <dd className="text-[var(--km-fg)]">{formatBeijing(batch.cutoffAt)}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd className="text-[var(--km-fg)]">{formatBeijing(batch.createdAt)}</dd>
          </div>
          <div>
            <dt>明细</dt>
            <dd className="text-[var(--km-fg)]">
              商店 {batch.storeCount} · 调整 {batch.adjustmentCount} · 提卡 {batch.drawCount}
            </dd>
          </div>
          <div>
            <dt>创建人 ID</dt>
            <dd className="text-[var(--km-fg)]">{batch.createdBy}</dd>
          </div>
        </dl>
        {batch.paymentReference || batch.paidAt ? (
          <p className="text-xs text-[var(--km-fg-muted)]">
            {batch.status === "cleared" ? "结清" : "付款"}：{paymentMethodLabel(batch.paymentMethod)} · 流水{" "}
            <span className="font-mono">{batch.paymentReference || "—"}</span> · 实际付款{" "}
            {formatBeijing(batch.actualPaymentAt)} · 登记 {formatBeijing(batch.paidAt)}
            {batch.paymentNote ? ` · 备注 ${batch.paymentNote}` : ""}
          </p>
        ) : null}
        {batch.status === "cancelled" ? (
          <p className="text-xs text-[var(--km-fg-muted)]">已于 {formatBeijing(batch.cancelledAt)} 取消，明细已回到未结，可重新生成。</p>
        ) : null}
      </div>

      <section className="space-y-2" aria-label="快照明细">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">快照明细（共 {total} 条）</h4>
          <div className="flex flex-wrap gap-2 text-xs">
            {csvLinks.map((link) => (
              <a key={link.href} className="km-btn km-btn-ghost km-btn-sm" href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
        </div>
        <TypeTabs
          value={type}
          onChange={(value) => {
            setType(value);
            setCursor(0);
          }}
          counts={{
            "": batch.storeCount + batch.adjustmentCount + batch.drawCount,
            earning: batch.storeCount,
            adjustment: batch.adjustmentCount,
            draw_item: batch.drawCount,
          }}
        />
        {itemsError ? (
          <p className="text-sm text-[var(--km-danger)]">
            {itemsError}{" "}
            <button type="button" className="underline" onClick={() => void loadItems()}>
              重试
            </button>
          </p>
        ) : null}
        {itemsLoading && !items.length ? <p className="text-sm text-[var(--km-fg-muted)]">加载明细…</p> : null}
        <LinesTable
          lines={lines}
          extra={
            canCorrect
              ? (line) => {
                  const item = byKey.get(line.key);
                  return item && correctable(item) ? (
                    <button type="button" className="text-xs underline" onClick={() => setCorrectionItemId(item.id)}>
                      记更正
                    </button>
                  ) : null;
                }
              : undefined
          }
        />
        {cursor > 0 || nextCursor !== null ? (
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={cursor === 0 || itemsLoading}
              onClick={() => setCursor(Math.max(0, cursor - PAGE))}
            >
              上一页
            </button>
            <span>
              第 {cursor + 1}–{cursor + items.length} 条
            </span>
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={nextCursor === null || itemsLoading}
              onClick={() => nextCursor !== null && setCursor(nextCursor)}
            >
              下一页
            </button>
          </div>
        ) : null}
      </section>

      {batch.status === "draft" ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="km-btn" disabled={busy} onClick={() => void confirmBatch()}>
            确认这批
          </button>
          <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void cancelBatch()}>
            取消批次
          </button>
        </div>
      ) : null}

      {batch.status === "pending_payment" && batch.netCents === 0 ? (
        <div className={`${ACTION_BAR} flex flex-wrap gap-2`}>
          <button type="button" className="km-btn" disabled={busy} onClick={() => void clearBatch()}>
            确认抵平结清
          </button>
          <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void cancelBatch()}>
            取消批次
          </button>
        </div>
      ) : null}

      {batch.status === "pending_payment" && batch.netCents !== 0 ? (
        <PaymentForm
          key={`pay-${batch.id}`}
          batch={batch}
          agentName={agentName}
          busy={busy}
          write={write}
          ask={ask}
          onChanged={onChanged}
          onCancel={() => void cancelBatch()}
        />
      ) : null}

      {canCorrect ? (
        <CorrectionForm
          key={`corr-${batch.id}`}
          batch={batch}
          items={items}
          selectedItemId={correctionItemId}
          onSelectItem={setCorrectionItemId}
          busy={busy}
          write={write}
          ask={ask}
          onChanged={onChanged}
        />
      ) : null}

      {isCancellableStatus(batch.status) ? null : batch.status === "cancelled" ? null : (
        <p className="text-xs text-[var(--km-fg-muted)]">{statusLabel(batch.status)}批次不能取消，金额有误请记更正。</p>
      )}

      <AuditTimeline batch={batch} />
    </div>
  );
}

function PaymentForm({
  batch,
  agentName,
  busy,
  write,
  ask,
  onChanged,
  onCancel,
}: {
  batch: BatchDetail;
  agentName: string;
  busy: boolean;
  write: WriteFn;
  ask: Ask;
  onChanged: (batchId: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState("bank");
  const [reference, setReference] = useState("");
  const [paidAtLocal, setPaidAtLocal] = useState(() => beijingInputValue());
  const [note, setNote] = useState("");
  const direction = directionOfNet(batch.netCents);
  const amountCents = Math.abs(batch.netCents);
  const paidAtIso = beijingInputToUtcIso(paidAtLocal);
  const [tick, setTick] = useState(() => Date.now());
  const paidAtFuture = isPaidAtInFuture(paidAtIso, new Date(tick));
  const canSubmit = Boolean(reference.trim() && paidAtIso) && !paidAtFuture && !busy;
  const methodLabel = PAYMENT_METHODS.find((item) => item.value === method)?.label || "其他";

  async function submit() {
    if (!reference.trim() || !paidAtIso) return;
    // 点击时再按最新时间校验一次，输入框停留太久也不会漏掉。
    const now = Date.now();
    setTick(now);
    if (isPaidAtInFuture(paidAtIso, new Date(now))) return;
    const answer = await ask({
      title: "确认登记付款",
      message: `确认登记：${batch.batchNo} · ${agentName} ${directionText(direction)} ${formatYuan(amountCents)}，方式 ${methodLabel}，流水 ${reference.trim()}，付款时间 ${paidAtLocal.replace("T", " ")}（北京时间）`,
      confirmLabel: "确认登记",
    });
    if (!answer) return;
    const result = await write({
      op: "mark_paid",
      scope: `batch${batch.id}`,
      url: `/api/admin/reconciliations/${batch.id}`,
      method: "PATCH",
      body: {
        action: "mark_paid",
        expectedVersion: batch.version,
        snapshotHash: batch.snapshotHash,
        direction,
        currency: "CNY",
        amountCents,
        paymentMethod: method,
        paymentReference: reference.trim(),
        actualPaymentAt: paidAtIso,
        note: note.trim(),
      },
      stage: "payment",
    });
    if (result?.ok) await onChanged(batch.id);
  }

  return (
    <section className="space-y-3 rounded-2xl border border-[var(--km-border)] p-4 pb-28 md:pb-4" aria-label="登记付款">
      <h4 className="font-medium">登记付款</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="text-xs text-[var(--km-fg-muted)]">
          方向与金额（按净额自动带出，不能改）
          <p className="mt-1 text-sm">
            <NetText netCents={batch.netCents} /> · 人民币
          </p>
        </div>
        <label className="text-xs text-[var(--km-fg-muted)]">
          付款方式
          <select className="km-input mt-1 w-full" value={method} onChange={(event) => setMethod(event.target.value)}>
            {PAYMENT_METHODS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--km-fg-muted)]">
          流水号（必填）
          <input
            className="km-input mt-1 w-full"
            value={reference}
            maxLength={128}
            onChange={(event) => setReference(event.target.value)}
            placeholder="转账流水号 / 订单号"
          />
        </label>
        <label className="text-xs text-[var(--km-fg-muted)]">
          实际付款时间（北京时间）
          <input
            type="datetime-local"
            className="km-input mt-1 w-full"
            value={paidAtLocal}
            onChange={(event) => {
              setPaidAtLocal(event.target.value);
              setTick(Date.now());
            }}
          />
          {!paidAtIso ? <span className="text-[var(--km-danger)]">请填写有效时间</span> : null}
          {paidAtFuture ? <span className="block text-[var(--km-danger)]">{PAID_AT_FUTURE_TEXT}</span> : null}
        </label>
        <label className="text-xs text-[var(--km-fg-muted)] sm:col-span-2">
          备注（可选）
          <input className="km-input mt-1 w-full" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        </label>
      </div>
      <div className={`${ACTION_BAR} flex flex-wrap items-center gap-2`}>
        <span className="text-sm md:hidden">
          <NetText netCents={batch.netCents} />
        </span>
        <button type="button" className="km-btn" disabled={!canSubmit} onClick={() => void submit()}>
          登记 {directionText(direction)} {formatYuan(amountCents)}
        </button>
        <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={onCancel}>
          取消批次
        </button>
        {!reference.trim() ? <span className="text-xs text-[var(--km-fg-muted)]">先填流水号</span> : null}
        {paidAtFuture ? <span className="text-xs text-[var(--km-danger)]">{PAID_AT_FUTURE_TEXT}</span> : null}
      </div>
    </section>
  );
}

function CorrectionForm({
  batch,
  items,
  selectedItemId,
  onSelectItem,
  busy,
  write,
  ask,
  onChanged,
}: {
  batch: BatchDetail;
  items: BatchItem[];
  selectedItemId: number;
  onSelectItem: (id: number) => void;
  busy: boolean;
  write: WriteFn;
  ask: Ask;
  onChanged: (batchId: number) => Promise<void>;
}) {
  const options = items.filter(correctable);
  const [type, setType] = useState<CorrectionType>("refund");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [sequenceText, setSequenceText] = useState("");
  /** 同一次填写的事件 UUID：失败重试复用，成功或换明细后才换。 */
  const [eventUuid, setEventUuid] = useState(newUuid);
  const [failedOnce, setFailedOnce] = useState(false);

  const item = options.find((row) => row.id === selectedItemId) || null;

  const suggestedSequence = useMemo(() => {
    if (!item) return 1;
    const orderId = itemOrderId(item);
    const mapped = adjustTypeOf(type);
    const seen = items
      .filter((row) => row.sourceType === "adjustment" && itemOrderId(row) === orderId && str(row.snapshot?.type) === mapped)
      .map((row) => Number(row.snapshot?.sequence) || 0);
    return (seen.length ? Math.max(...seen) : 0) + 1;
  }, [item, items, type]);

  const sequence = sequenceText ? Number(sequenceText) : suggestedSequence;
  const amountCents = parseYuanInput(amountText);
  const negativeType = CORRECTION_TYPES.find((row) => row.value === type)?.negative;
  const businessEventKey = item ? correctionEventKey(batch.id, item.id, eventUuid) : "";
  const missing = correctionMissing({
    hasItem: Boolean(item),
    amountText,
    amountCents,
    reason,
    sequence,
  });
  const valid = missing.length === 0;

  async function submit() {
    if (!item || amountCents === null || !valid) return;
    const typeLabel = CORRECTION_TYPES.find((row) => row.value === type)?.label || type;
    const answer = await ask({
      title: "确认记更正",
      message: `${batch.batchNo} · ${item.sourceOrderNo}\n类型 ${typeLabel}，金额 ${formatSignedYuan(amountCents)}，序号 ${sequence}\n原因：${reason.trim()}\n更正会生成一条待结调整，进入下一次对账批次，原快照不变。`,
      confirmLabel: "确认记更正",
    });
    if (!answer) return;

    const result = await write({
      op: "correction",
      scope: `batch${batch.id}`,
      url: `/api/admin/reconciliations/${batch.id}/corrections`,
      method: "POST",
      body: {
        sourceItemId: item.id,
        type,
        amountCents,
        reason: reason.trim(),
        reference: reference.trim(),
        businessEventKey,
        expectedCorrectionSequence: sequence,
      },
      stage: "correction",
    });
    if (!result) return;
    if (result.ok) {
      setAmountText("");
      setReason("");
      setReference("");
      setSequenceText("");
      setFailedOnce(false);
      setEventUuid(newUuid());
      await onChanged(batch.id);
      return;
    }
    // 事件标识保持不变：同一次填写重试仍是同一账务事件，直到成功或用户主动换新。
    setFailedOnce(true);
    if (result.code === "CORRECTION_SEQUENCE_CONFLICT") {
      const next = parseNextSequence(result.message);
      if (next) setSequenceText(String(next));
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-[var(--km-border)] p-4" aria-label="记一笔更正">
      <h4 className="font-medium">记一笔更正</h4>
      <p className="text-xs text-[var(--km-fg-muted)]">
        已结批次的金额不能改。退款、手续费差额等要新记一笔更正，进入下一次对账批次。只能选当前页已加载的商店收益/调整明细。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[var(--km-fg-muted)] sm:col-span-2">
          明细
          <select
            className="km-input mt-1 w-full"
            value={selectedItemId || ""}
            onChange={(event) => {
              onSelectItem(Number(event.target.value) || 0);
              setSequenceText("");
            }}
          >
            <option value="">选择要更正的明细</option>
            {options.map((row) => (
              <option key={row.id} value={row.id}>
                {row.sourceOrderNo} · {row.sourceType === "earning" ? "商店收益" : "调整"} {formatSignedYuan(row.amountCents)}
              </option>
            ))}
          </select>
          {!options.length ? <span>当前页没有可更正的明细，翻页或切换类型后再选。</span> : null}
        </label>
        <label className="text-xs text-[var(--km-fg-muted)]">
          类型
          <select
            className="km-input mt-1 w-full"
            value={type}
            onChange={(event) => {
              setType(event.target.value as CorrectionType);
              setSequenceText("");
            }}
          >
            {CORRECTION_TYPES.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--km-fg-muted)]">
          金额（元，可带负号）
          <input
            className="km-input mt-1 w-full"
            inputMode="decimal"
            value={amountText}
            placeholder={negativeType ? "例如 -40.00" : "例如 -20.00 或 15.00"}
            onChange={(event) => setAmountText(event.target.value)}
          />
          {amountText && amountCents === null ? <span className="text-[var(--km-danger)]">金额格式不对，最多两位小数</span> : null}
          {negativeType && amountCents !== null && amountCents > 0 ? (
            <span className="text-[var(--km-warning)]">退款/冲正一般应为负数（减少代理收益），请确认</span>
          ) : null}
          {amountCents !== null && amountCents !== 0 ? <span>将记为 {formatSignedYuan(amountCents)}</span> : null}
        </label>
        <label className="text-xs text-[var(--km-fg-muted)]">
          原因（必填）
          <input className="km-input mt-1 w-full" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </label>
        <label className="text-xs text-[var(--km-fg-muted)]">
          参考号（可选）
          <input className="km-input mt-1 w-full" value={reference} maxLength={128} onChange={(event) => setReference(event.target.value)} />
        </label>
        <label className="text-xs text-[var(--km-fg-muted)]">
          更正序号（同订单同类型递增，建议 {suggestedSequence}）
          <input
            className="km-input mt-1 w-full"
            inputMode="numeric"
            value={sequenceText || String(suggestedSequence)}
            onChange={(event) => setSequenceText(event.target.value.replace(/\D/g, ""))}
          />
        </label>
        <div className="text-xs text-[var(--km-fg-muted)]">
          事件标识
          <p className="mt-1 break-all font-mono">{businessEventKey || "选明细后生成"}</p>
          {failedOnce ? (
            <button
              type="button"
              className="underline"
              onClick={() => {
                setEventUuid(newUuid());
                setFailedOnce(false);
              }}
            >
              这是另一笔新更正，换新标识
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="km-btn" disabled={!valid || busy} onClick={() => void submit()}>
          提交更正
        </button>
        {missing.length ? (
          <span className="text-xs text-[var(--km-warning)]" role="status">
            {missing.join("；")}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function auditSummary(row: BatchDetail["audits"][number]) {
  const after = (row.metadata?.after || {}) as Record<string, unknown>;
  const before = (row.metadata?.before || {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof before.status === "string" && typeof after.status === "string") {
    parts.push(`${statusLabel(before.status)} → ${statusLabel(after.status)}`);
  } else if (typeof after.status === "string") {
    parts.push(statusLabel(after.status));
  }
  if (typeof after.paymentReference === "string" && after.paymentReference) parts.push(`流水 ${after.paymentReference}`);
  if (typeof after.amountCents === "number" && row.action === "reconciliation.correction") {
    parts.push(`更正 ${formatSignedYuan(after.amountCents)}`);
  }
  if (typeof after.sequence === "number") parts.push(`序号 ${after.sequence}`);
  return parts.join(" · ");
}

function AuditTimeline({ batch }: { batch: BatchDetail }) {
  return (
    <section className="space-y-2" aria-label="审计时间线">
      <h4 className="font-medium">审计时间线</h4>
      {!batch.audits.length ? <p className="text-sm text-[var(--km-fg-muted)]">还没有审计记录。</p> : null}
      <ol className="space-y-2 border-l border-[var(--km-border)] pl-4 text-xs">
        {batch.audits.map((row) => (
          <li key={row.id}>
            <p className="font-medium">
              {auditActionLabel(row.action)} <span className="font-normal text-[var(--km-fg-muted)]">{formatBeijing(row.createdAt)}</span>
            </p>
            <p className="text-[var(--km-fg-muted)]">
              {row.actorRole === "super_admin" ? "管理员" : row.actorRole}
              {row.ip ? ` · IP ${row.ip}` : ""}
              {auditSummary(row) ? ` · ${auditSummary(row)}` : ""}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
