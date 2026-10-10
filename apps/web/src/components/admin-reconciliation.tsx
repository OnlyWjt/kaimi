"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { KmSelect } from "@/components/km-select";
import { type WriteFn, type WriteInput } from "@/components/admin-reconciliation-batch";
import {
  apiCall,
  NoticeBar,
  viewOf,
  type AgentListData,
  type AgentRow,
  type BatchDetail,
  type BatchItem,
  type BatchItemsData,
  type BatchListData,
  type BatchRow,
  type Notice,
  type Preview,
  type PreviewItem,
} from "@/components/admin-reconciliation-shared";
import {
  directionOfNet,
  formatBeijing,
  formatSignedYuan,
  formatYuan,
  isActiveBatchStatus,
  isUnpaidBatchStatus,
  parseLocked,
  paymentMethodLabel,
  PAYMENT_METHODS,
  reuseOrCreateKey,
  skipCodeLabel,
  skippedAckKey,
  skippedKey,
  statusLabel,
  type ErrorAction,
  type IdemEntry,
} from "@/lib/admin-reconciliation-ui";

type DetailTab = "store" | "draw" | "history";

type Face = {
  key: string;
  type: string;
  orderNo: string;
  amountCents: number;
  occurredAt: string;
  title: string;
  goodsCents: number | null;
  feeCents: number | null;
  count: number;
};

const ACTION_LABELS: Record<ErrorAction, string> = {
  repreview: "重新预览",
  cancel_rebuild: "取消批次后重新生成",
  open_batch: "打开批次",
  refresh: "刷新",
  new_event: "刷新批次",
  relogin: "去登录",
};

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 有待处理批次时优先打开它：未付款 > 更正中。 */
function pickActiveBatch(list: BatchRow[]) {
  return list.find((row) => isUnpaidBatchStatus(row.status)) || list.find((row) => isActiveBatchStatus(row.status)) || null;
}

export function AdminReconciliation() {
  const { ask, dialog } = useAskDialog();
  /** 列表与预览共用的截止时间（UTC ISO，来自后端回显）。空表示还没加载。 */
  const [cutoffAt, setCutoffAt] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(0);
  const [selectedName, setSelectedName] = useState("");
  const [detail, setDetail] = useState<DetailTab>("store");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sheet, setSheet] = useState<Face[]>([]);
  const [settleOpen, setSettleOpen] = useState(false);
  const [payMethod, setPayMethod] = useState("alipay");
  const [payRef, setPayRef] = useState("");
  const [payNote, setPayNote] = useState("");
  const [settleError, setSettleError] = useState("");
  /** 已勾选确认的跳过项指纹；与当前预览指纹不一致就视为没勾。 */
  const [ackedKey, setAckedKey] = useState("");
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [batchesNext, setBatchesNext] = useState<number | null>(null);
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [itemsVersion, setItemsVersion] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  /** 写操作同步锁：state 更新是异步的，双击时只靠 state 拦不住。 */
  const lockRef = useRef(false);
  /** 每个操作槽的幂等键：同一操作同一内容失败重试复用，内容变化或成功后换新。 */
  const idemRef = useRef<Record<string, IdemEntry | undefined>>({});
  /** 每个代理当前打开的批次，刷新和切换代理后找回。 */
  const openBatchRef = useRef<Record<number, number>>({});
  const selectedRef = useRef(0);
  const filtersRef = useRef({ search });
  useEffect(() => {
    filtersRef.current = { search };
  }, [search]);

  const loadList = useCallback(async (nextCutoff: string, append = false, cursor = "") => {
    setListLoading(true);
    const params = new URLSearchParams({ search: filtersRef.current.search, status: "", sort: "net", limit: "50" });
    if (nextCutoff) params.set("cutoffAt", nextCutoff);
    if (cursor) params.set("cursor", cursor);
    const result = await apiCall<AgentListData>(`/api/admin/reconciliations/agents?${params}`);
    setListLoading(false);
    if (!result.ok) {
      const view = viewOf(result, "list");
      setNotice({ kind: "err", text: view.text, detail: view.detail, action: view.action });
      return null;
    }
    setCutoffAt(result.data.cutoffAt);
    setRows((current) => (append ? [...current, ...result.data.list] : result.data.list));
    setNextCursor(result.data.nextCursor);
    if (!append && !selectedRef.current && result.data.list[0]) {
      const first = result.data.list[0];
      selectedRef.current = first.agentId;
      setSelectedId(first.agentId);
      setSelectedName(first.name);
      void loadPreview(first.agentId, result.data.cutoffAt);
    }
    return result.data;
  }, []);

  const loadPreview = useCallback(async (agentId: number, nextCutoff: string) => {
    const params = nextCutoff ? `?cutoffAt=${encodeURIComponent(nextCutoff)}` : "";
    const result = await apiCall<Preview>(`/api/admin/reconciliations/agents/${agentId}/preview${params}`);
    if (selectedRef.current !== agentId) return null;
    if (!result.ok) {
      const view = viewOf(result, "preview");
      setNotice({ kind: "err", text: view.text, detail: view.detail, action: view.action });
      return null;
    }
    setPreview(result.data);
    return result.data;
  }, []);

  const loadBatch = useCallback(async (batchId: number, quiet = false) => {
    const result = await apiCall<BatchDetail>(`/api/admin/reconciliations/${batchId}`);
    if (!result.ok) {
      if (!quiet) {
        const view = viewOf(result, "list");
        setNotice({ kind: "err", text: `批次没加载出来：${view.text}`, detail: view.detail });
      }
      return null;
    }
    if (selectedRef.current && result.data.agentId !== selectedRef.current) return null;
    openBatchRef.current[result.data.agentId] = result.data.id;
    setBatch(result.data);
    setItemsVersion((value) => value + 1);
    return result.data;
  }, []);

  const loadBatches = useCallback(async (agentId: number, append = false, cursor = 0) => {
    const params = new URLSearchParams({ cursor: String(cursor), limit: "50" });
    const result = await apiCall<BatchListData>(`/api/admin/reconciliations/agents/${agentId}/batches?${params}`);
    if (selectedRef.current !== agentId) return null;
    if (!result.ok) {
      const view = viewOf(result, "list");
      setNotice({ kind: "err", text: `批次历史没加载出来：${view.text}`, detail: view.detail });
      return null;
    }
    setBatches((current) => (append ? [...current, ...result.data.list] : result.data.list));
    setBatchesNext(result.data.nextCursor);
    return result.data.list;
  }, []);

  /** 载入代理的批次并找回正在处理的批次：先找之前打开的，再找未付款/更正中的。 */
  const restoreBatch = useCallback(
    async (agentId: number, preferActive: boolean) => {
      const list = await loadBatches(agentId);
      if (!list || selectedRef.current !== agentId) return null;
      const remembered = openBatchRef.current[agentId];
      const rememberedRow = remembered ? list.find((row) => row.id === remembered) : undefined;
      const target =
        (rememberedRow && isActiveBatchStatus(rememberedRow.status) ? rememberedRow : null) ||
        (preferActive ? pickActiveBatch(list) : null) ||
        rememberedRow ||
        null;
      if (!target) {
        setBatch(null);
        return null;
      }
      return loadBatch(target.id);
    },
    [loadBatch, loadBatches],
  );

  useEffect(() => {
    void loadList("");
  }, [loadList]);

  async function selectAgent(row: AgentRow) {
    if (row.agentId === selectedRef.current) return;
    selectedRef.current = row.agentId;
    setSelectedId(row.agentId);
    setSelectedName(row.name);
    setPreview(null);
    setBatch(null);
    setBatches([]);
    setBatches([]);
    setSheet([]);
    setDetail("store");
    setSettleOpen(false);
    setSettleError("");
    setAckedKey("");
    setNotice(null);
    await loadPreview(row.agentId, cutoffAt);
  }

  /** 「刷新到现在」：不带 cutoffAt，让后端用服务器当前时间，避免浏览器时钟偏快触发 INVALID_STATE。 */
  async function refreshToNow() {
    setNotice(null);
    const data = await loadList("");
    const agentId = selectedRef.current;
    if (!data || !agentId) return;
    await Promise.all([loadPreview(agentId, data.cutoffAt), restoreBatch(agentId, true)]);
  }

  async function reloadAgent(agentId: number) {
    const data = await loadList(cutoffAt);
    await Promise.all([loadPreview(agentId, data?.cutoffAt || cutoffAt), restoreBatch(agentId, true)]);
  }

  const write: WriteFn = useCallback(
    async (input: WriteInput) => {
      if (lockRef.current) return null;
      lockRef.current = true;
      setBusy(true);
      setNotice(null);
      const slot = `${input.op}:${input.scope}`;
      const entry = reuseOrCreateKey(idemRef.current[slot], input.op, input.scope, input.body, newId);
      idemRef.current[slot] = entry;
      const agentId = selectedRef.current;
      try {
        const result = await apiCall<unknown>(input.url, {
          method: input.method,
          headers: { "Content-Type": "application/json", "Idempotency-Key": entry.key },
          body: JSON.stringify(input.body),
        });
        if (result.ok) {
          idemRef.current[slot] = undefined;
          return result;
        }
        const view = viewOf(result, input.stage);
        setNotice({ kind: "err", text: view.text, detail: view.detail, action: view.action });
        if (view.unknown && agentId) {
          // 结果未知：保留幂等键（重试会拿到首次结果），并重新载入该代理批次，防止误以为失败而重复生成。
          await restoreBatch(agentId, true);
          if (selectedRef.current === agentId) {
            await loadList(cutoffAt);
            await loadPreview(agentId, cutoffAt);
          }
        }
        if (result.status === 401 || result.status === 403) idemRef.current[slot] = undefined;
        return result;
      } finally {
        lockRef.current = false;
        setBusy(false);
      }
    },
    [cutoffAt, loadList, loadPreview, restoreBatch],
  );

  async function onBatchChanged(batchId: number) {
    const agentId = selectedRef.current;
    const fresh = await loadBatch(batchId);
    if (fresh) {
      const text =
        fresh.status === "cancelled"
          ? `已取消 ${fresh.batchNo}，明细回到未结，可重新生成`
          : fresh.status === "pending_payment"
            ? `${fresh.batchNo} 已确认，等待登记付款`
            : `${fresh.batchNo} 现在是「${statusLabel(fresh.status)}」`;
      setNotice({ kind: "ok", text });
      if (fresh.status === "cancelled" || fresh.status === "paid" || fresh.status === "cleared") {
        delete openBatchRef.current[fresh.agentId];
      }
    }
    if (agentId) {
      const data = await loadList(cutoffAt);
      await Promise.all([loadPreview(agentId, data?.cutoffAt || cutoffAt), loadBatches(agentId)]);
    }
  }

  async function settleNow(netCents: number) {
    const agentId = selectedRef.current;
    if (!agentId || !preview) return;
    if (netCents !== 0 && !payRef.trim()) {
      setSettleError("填写流水号");
      return;
    }
    setSettleError("");
    const listed = rows.find((row) => row.agentId === agentId)?.latestBatch;
    const existing = listed && isUnpaidBatchStatus(listed.status) ? listed : undefined;
    let current: { id: number; version: number; snapshotHash: string; status: string } | null = existing
      ? { id: existing.id, version: existing.version, snapshotHash: existing.snapshotHash, status: existing.status }
      : null;
    if (!current) {
      if (!preview.items.length) return;
      if (preview.skipped.length && ackedKey !== skippedAckKey(preview.previewVersion, preview.cutoffAt, preview.skipped)) return;
      const body: Record<string, unknown> = {
        agentId: preview.agentId,
        cutoffAt: preview.cutoffAt,
        previewVersion: preview.previewVersion,
        items: preview.items.map((item) => ({ type: item.type, id: item.id, version: item.version })),
      };
      if (preview.skipped.length) body.acknowledgedSkipped = preview.skipped.map((item) => item.orderNo);
      const created = await write({
        op: "create",
        scope: `agent${preview.agentId}-${preview.previewVersion}`,
        url: "/api/admin/reconciliations",
        method: "POST",
        body,
        stage: "create",
      });
      if (!created?.ok) return;
      const data = created.data as { id: number; version: number; snapshotHash: string; status: string };
      current = data;
      openBatchRef.current[agentId] = data.id;
    }
    if (current.status === "draft") {
      const confirmed = await write({
        op: "confirm",
        scope: `batch${current.id}`,
        url: `/api/admin/reconciliations/${current.id}`,
        method: "PATCH",
        body: { action: "confirm", expectedVersion: current.version, snapshotHash: current.snapshotHash },
        stage: "batch",
      });
      if (!confirmed?.ok) return;
      const data = confirmed.data as { version: number; snapshotHash: string };
      current = { ...current, status: "pending_payment", version: data.version, snapshotHash: data.snapshotHash };
    }
    const paid = netCents === 0
      ? await write({
          op: "clear",
          scope: `batch${current.id}`,
          url: `/api/admin/reconciliations/${current.id}`,
          method: "PATCH",
          body: { action: "clear", expectedVersion: current.version, snapshotHash: current.snapshotHash },
          stage: "payment",
        })
      : await write({
          op: "mark_paid",
          scope: `batch${current.id}`,
          url: `/api/admin/reconciliations/${current.id}`,
          method: "PATCH",
          body: {
            action: "mark_paid",
            expectedVersion: current.version,
            snapshotHash: current.snapshotHash,
            direction: directionOfNet(netCents),
            currency: "CNY",
            amountCents: Math.abs(netCents),
            paymentMethod: payMethod,
            paymentReference: payRef.trim(),
            actualPaymentAt: new Date().toISOString(),
            note: payNote.trim(),
          },
          stage: "payment",
        });
    if (!paid?.ok) return;
    setSettleOpen(false);
    setPayRef("");
    setPayNote("");
    setDetail("history");
    setNotice({ kind: "ok", text: netCents === 0 ? "已按净额为零结清，此后收益重新累计。" : "已登记结算，此后收益重新累计。" });
    await onBatchChanged(current.id);
  }

  /**
   * 只打开指定 id 的批次：先在已加载的批次列表里找，找不到再直接 GET /:id。
   * 不会兜底打开其他批次；都失败就提示刷新。
   */
  async function openBatchByIds(batchIds: number[]) {
    const agentId = selectedRef.current;
    if (!agentId || !batchIds.length) {
      setNotice({ kind: "err", text: "批次未找到，请刷新" });
      return;
    }
    const known = new Map(batches.map((row) => [row.id, row]));
    const ordered = [...batchIds].sort((a, b) => {
      const rank = (id: number) => (known.get(id) && isUnpaidBatchStatus(known.get(id)!.status) ? 0 : 1);
      return rank(a) - rank(b);
    });
    for (const id of ordered) {
      const found = await loadBatch(id, true);
      if (found) {
        setNotice(null);
        setDetail("store");
        setSettleOpen(true);
        return;
      }
    }
    setNotice({ kind: "err", text: "批次未找到，请刷新", action: "refresh" });
  }

  /** 「有明细已在其他批次」：只打开本代理里还没付款的批次，没有就提示刷新，不乱开别的批次。 */
  async function openUnpaidBatch() {
    const agentId = selectedRef.current;
    if (!agentId) return;
    const list = (await loadBatches(agentId)) || [];
    const ids = list.filter((row) => isUnpaidBatchStatus(row.status)).map((row) => row.id);
    await openBatchByIds(ids);
  }
  async function cancelForRebuild() {
    // 先重读批次，拿到最新 version/snapshotHash，避免用旧版本再撞 SNAPSHOT_CHANGED。
    const current = batch ? await loadBatch(batch.id) : null;
    if (!current || !(current.status === "draft" || current.status === "pending_payment")) {
      await openUnpaidBatch();
      return;
    }
    const answer = await ask({
      title: "取消批次后重新生成",
      message: `明细已变化，${current.batchNo} 不能继续。\n取消后明细回到未结，可重新生成。`,
      confirmLabel: "取消批次",
      cancelLabel: "先不动",
      danger: true,
    });
    if (!answer) return;
    const result = await write({
      op: "cancel",
      scope: `batch${current.id}`,
      url: `/api/admin/reconciliations/${current.id}`,
      method: "PATCH",
      body: { action: "cancel", expectedVersion: current.version, snapshotHash: current.snapshotHash },
      stage: "batch",
    });
    if (result?.ok) {
      await onBatchChanged(current.id);
      setDetail("store");
    }
  }

  function runNoticeAction(action: ErrorAction) {
    const agentId = selectedRef.current;
    if (action === "relogin") {
      window.location.href = "/login";
      return;
    }
    if (action === "repreview") {
      setNotice(null);
      if (agentId) void loadPreview(agentId, cutoffAt).then(() => setDetail("store"));
      return;
    }
    if (action === "cancel_rebuild") {
      void cancelForRebuild();
      return;
    }
    if (action === "open_batch") {
      setNotice(null);
      void openUnpaidBatch();
      return;
    }
    setNotice(null);
    if (agentId) void reloadAgent(agentId);
    else void loadList(cutoffAt);
  }

  const unpaid = (() => {
    const latest = rows.find((row) => row.agentId === selectedId)?.latestBatch;
    return latest && isUnpaidBatchStatus(latest.status) ? latest : null;
  })();

  useEffect(() => {
    if (!unpaid) {
      setSheet([]);
      return;
    }
    let cancel = false;
    void apiCall<BatchItemsData>(`/api/admin/reconciliations/${unpaid.id}/items?limit=100`).then((result) => {
      if (cancel || !result.ok) return;
      setSheet(result.data.items.map(faceFromBatch));
    });
    return () => {
      cancel = true;
    };
  }, [unpaid]);

  useEffect(() => {
    if (detail !== "history" || !selectedId) return;
    void loadBatches(selectedId);
  }, [detail, selectedId, loadBatches]);

  const selected = rows.find((row) => row.agentId === selectedId) || null;
  const agentName = selected?.name || selectedName || (selectedId ? `代理 ${selectedId}` : "");
  const previewFaces = (preview?.items || []).map(faceFromPreview);
  const faces = unpaid ? sheet : previewFaces;
  const storeFaces = faces.filter((line) => line.type === "earning" || line.type === "adjustment");
  const drawFaces = groupDraws(faces.filter((line) => line.type === "draw_item"));
  const storeCents = unpaid ? unpaid.storeEarningCents : preview?.totals.storeEarningCents || 0;
  const adjustmentCents = unpaid ? unpaid.adjustmentCents : preview?.totals.adjustmentCents || 0;
  const drawCents = unpaid ? unpaid.drawDebtCents : preview?.totals.drawDebtCents || 0;
  const netCents = unpaid ? unpaid.netCents : preview?.totals.netCents || 0;
  const storeCount = unpaid ? unpaid.storeCount : faces.filter((line) => line.type === "earning").length;
  const drawCount = unpaid ? unpaid.drawCount : faces.filter((line) => line.type === "draw_item").length;
  const locked = preview ? parseLocked(preview) : null;
  const ackKey = preview ? skippedAckKey(preview.previewVersion, preview.cutoffAt, preview.skipped) : "";
  const skippedAcked = Boolean(preview?.skipped.length) && ackedKey === ackKey;
  const hasWork = Boolean(unpaid || preview?.items.length);
  const canSettle = hasWork && (!preview?.skipped.length || skippedAcked) && !busy;
  const query = search.trim().toLowerCase();
  const visibleRows = rows.filter((row) => !query || row.name.toLowerCase().includes(query));
  const settled = batches.filter((row) => row.status === "paid" || row.status === "cleared");
  const waitingSheet = Boolean(unpaid && unpaid.storeCount + unpaid.adjustmentCount + unpaid.drawCount > 0 && !sheet.length);

  function exportCurrent() {
    if (detail === "history") {
      downloadCsv(`${agentName}-已结算.csv`, [
        ["时间", "单号", "方向", "方式", "流水号", "金额"],
        ...settled.map((row) => [
          shortTime(row.paidAt || row.createdAt),
          row.batchNo,
          youWords(row.netCents),
          paymentMethodLabel(row.paymentMethod),
          row.paymentReference || "",
          formatYuan(row.netCents),
        ]),
      ]);
      return;
    }
    if (detail === "draw") {
      downloadCsv(`${agentName}-提卡未结.csv`, [
        ["时间", "提卡单", "套餐", "张数", "金额"],
        ...drawFaces.map((line) => [shortTime(line.occurredAt), line.orderNo, line.title, String(line.count), formatYuan(line.amountCents)]),
      ]);
      return;
    }
    downloadCsv(`${agentName}-商店收益.csv`, [
      ["时间", "订单", "套餐", "货款", "手续费", "代理收益"],
      ...storeFaces.map((line) => [
        shortTime(line.occurredAt),
        line.orderNo,
        line.title,
        line.goodsCents === null ? "" : formatYuan(line.goodsCents),
        line.feeCents === null ? "" : formatYuan(line.feeCents),
        formatYuan(line.amountCents),
      ]),
    ]);
  }

  return (
    <div className="space-y-4">
      {dialog}
      {notice ? (
        <NoticeBar
          notice={notice}
          actionLabel={notice.action ? ACTION_LABELS[notice.action] : undefined}
          onAction={notice.action ? () => runNoticeAction(notice.action as ErrorAction) : undefined}
          onClose={() => setNotice(null)}
        />
      ) : null}
      <div>
        <p className="text-xs text-[var(--km-fg-muted)]">按代理累计结算，不再按自然周出单。</p>
        <h1 className="mt-1 text-2xl font-semibold">对账</h1>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className="km-panel" aria-label="代理名单">
          <h2 className="text-lg font-semibold">代理</h2>
          <input
            className="km-input mt-3"
            placeholder="搜索代理"
            aria-label="搜索代理"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="mt-2 max-h-[calc(100vh-280px)] space-y-1 overflow-auto">
            {visibleRows.map((row) => {
              const figures = rowFigures(
                row,
                row.latestBatch && isUnpaidBatchStatus(row.latestBatch.status) ? row.latestBatch : null,
              );
              const on = row.agentId === selectedId;
              return (
                <button
                  key={row.agentId}
                  type="button"
                  aria-pressed={on}
                  className={`w-full rounded-xl px-3 py-2.5 text-left ${on ? "bg-[var(--km-bg-muted)]" : "hover:bg-[var(--km-bg-muted)]"}`}
                  onClick={() => void selectAgent(row)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <b className="min-w-0 truncate text-sm">{row.name}</b>
                    <span className={`shrink-0 text-xs font-medium ${netTone(figures.net)}`}>{youWords(figures.net)}</span>
                  </span>
                  <span className="mt-1 block text-sm font-semibold">{formatYuan(figures.net)}</span>
                  <span className="mt-0.5 block text-xs text-[var(--km-fg-muted)]">
                    商店 {formatYuan(figures.store)}　提卡 {formatYuan(figures.draw)}
                  </span>
                </button>
              );
            })}
            {!visibleRows.length && !listLoading ? <p className="px-1 py-3 text-sm text-[var(--km-fg-muted)]">没有要结的代理。</p> : null}
            {listLoading ? <p className="px-1 py-2 text-xs text-[var(--km-fg-muted)]">加载中…</p> : null}
            {nextCursor ? (
              <button
                type="button"
                className="km-btn km-btn-ghost km-btn-sm w-full"
                disabled={listLoading}
                onClick={() => void loadList(cutoffAt, true, nextCursor)}
              >
                更多代理
              </button>
            ) : null}
          </div>
        </section>

        <div className="min-w-0 space-y-3">
          {!selectedId ? <p className="text-sm text-[var(--km-fg-muted)]">先选一个代理。</p> : null}
          {selectedId ? (
            <>
              <section className="km-panel">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{agentName}</h2>
                    <p className="mt-1 text-xs text-[var(--km-fg-muted)]">自上次结算起累计至当前。</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="km-btn km-btn-ghost" onClick={exportCurrent}>
                      导出
                    </button>
                    <button
                      type="button"
                      className="km-btn"
                      disabled={!canSettle}
                      onClick={() => {
                        setSettleError("");
                        setSettleOpen(true);
                      }}
                    >
                      {hasWork ? "登记已结算" : "暂无未结"}
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3">
                    <p className={`text-xs font-medium ${hasWork ? netTone(netCents) : "text-[var(--km-fg-muted)]"}`}>
                      {hasWork ? youWords(netCents) : "暂无未结"}
                    </p>
                    <p className={`mt-1 text-lg font-semibold tracking-tight ${hasWork ? netTone(netCents) : ""}`}>
                      {hasWork ? formatYuan(netCents) : "¥0.00"}
                    </p>
                  </div>
                  <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3">
                    <p className="text-xs text-[var(--km-fg-muted)]">商店待结</p>
                    <p className="mt-1 text-lg font-semibold tracking-tight">{formatYuan(storeCents)}</p>
                    <p className="mt-1 text-xs text-[var(--km-fg-muted)]">
                      {storeCount} 笔 · 平台应付
                      {adjustmentCents ? ` · 含调整 ${formatSignedYuan(adjustmentCents)}` : ""}
                    </p>
                  </div>
                  <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3">
                    <p className="text-xs text-[var(--km-fg-muted)]">提卡未结</p>
                    <p className="mt-1 text-lg font-semibold tracking-tight">{formatYuan(drawCents)}</p>
                    <p className="mt-1 text-xs text-[var(--km-fg-muted)]">{drawCount} 张 · 代理应付</p>
                  </div>
                </div>
                {locked?.legacy?.itemCount ? (
                  <p className="mt-3 text-xs text-[var(--km-fg-muted)]">
                    另有 {locked.legacy.itemCount} 笔、{youWords(locked.legacy.netCents)} {formatYuan(locked.legacy.netCents)} 在旧周结单
                    {locked.legacy.settlementNos.length ? ` ${locked.legacy.settlementNos.join("、")}` : ""} 中，请先在历史周结核验，核验后才会纳入本次对账。{" "}
                    <a className="underline" href="/admin#week">
                      去历史周结
                    </a>
                  </p>
                ) : null}
              </section>

              {settleOpen && canSettle ? (
                <section className="rounded-2xl border border-[var(--km-border)] p-4" aria-label="登记已结算">
                  <p className="font-semibold">
                    登记已结算 · {agentName} · {youWords(netCents)} {formatYuan(netCents)}
                  </p>
                  <p className="mt-1 text-xs text-[var(--km-fg-muted)]">
                    商店 {storeCount} 笔 {formatYuan(storeCents)}　提卡 {drawCount} 张 {formatYuan(drawCents)}
                  </p>
                  {netCents === 0 ? <p className="mt-3 text-sm text-[var(--km-fg-muted)]">净额为零，无需填写流水号。</p> : (
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="text-xs text-[var(--km-fg-muted)]">
                        方式
                        <KmSelect
                          className="mt-1"
                          value={payMethod}
                          onChange={setPayMethod}
                          options={PAYMENT_METHODS.map((item) => ({ value: item.value, label: item.label }))}
                        />
                      </label>
                      <label className="text-xs text-[var(--km-fg-muted)]">
                        流水号
                        <input className="km-input mt-1" value={payRef} onChange={(event) => setPayRef(event.target.value)} />
                      </label>
                      <label className="text-xs text-[var(--km-fg-muted)]">
                        备注
                        <input className="km-input mt-1" value={payNote} onChange={(event) => setPayNote(event.target.value)} />
                      </label>
                    </div>
                  )}
                  {settleError ? <p className="mt-2 text-sm text-[var(--km-danger)]">{settleError}</p> : null}
                  <div className="mt-3 flex gap-2">
                    <button type="button" className="km-btn km-btn-ghost" onClick={() => setSettleOpen(false)}>
                      取消
                    </button>
                    <button type="button" className="km-btn" disabled={busy} onClick={() => void settleNow(netCents)}>
                      {netCents > 0 ? `确认平台已付 ${formatYuan(netCents)}` : netCents < 0 ? `确认已收到 ${formatYuan(netCents)}` : "确认结清"}
                    </button>
                  </div>
                </section>
              ) : null}

              <div className="km-tabs" role="tablist">
                {(
                  [
                    ["store", "商店收益"],
                    ["draw", "提卡未结"],
                    ["history", "已结算"],
                  ] as Array<[DetailTab, string]>
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={detail === value}
                    className={`km-tab ${detail === value ? "km-tab-active" : ""}`}
                    onClick={() => setDetail(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <section className="km-panel overflow-x-auto">
                {detail === "store" ? (
                  storeFaces.length ? (
                    <>
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="text-xs text-[var(--km-fg-muted)]">
                            <th className="py-2 font-semibold">时间</th>
                            <th className="py-2 font-semibold">订单</th>
                            <th className="py-2 font-semibold">套餐</th>
                            <th className="py-2 font-semibold">货款</th>
                            <th className="py-2 font-semibold">手续费</th>
                            <th className="py-2 font-semibold">代理收益</th>
                          </tr>
                        </thead>
                        <tbody>
                          {storeFaces.map((line) => (
                            <tr key={line.key} className="border-t border-[var(--km-border)]">
                              <td className="py-2">{shortTime(line.occurredAt)}</td>
                              <td className="py-2 font-mono text-xs">{line.orderNo}</td>
                              <td className="py-2">{line.title || (line.type === "adjustment" ? "调整" : "—")}</td>
                              <td className="py-2">{line.goodsCents === null ? "—" : formatYuan(line.goodsCents)}</td>
                              <td className="py-2">{line.feeCents === null ? "—" : formatYuan(line.feeCents)}</td>
                              <td className="py-2">{line.type === "adjustment" ? formatSignedYuan(line.amountCents) : formatYuan(line.amountCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-3 text-xs text-[var(--km-fg-muted)]">
                        共 {storeCount} 笔，收益合计 {formatYuan(storeCents)}。开票加价归平台，不计入代理收益。
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-[var(--km-fg-muted)]">{waitingSheet || !preview ? "加载中…" : "没有待结算的商店收益。"}</p>
                  )
                ) : null}
                {detail === "draw" ? (
                  drawFaces.length ? (
                    <>
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="text-xs text-[var(--km-fg-muted)]">
                            <th className="py-2 font-semibold">时间</th>
                            <th className="py-2 font-semibold">提卡单</th>
                            <th className="py-2 font-semibold">套餐</th>
                            <th className="py-2 font-semibold">张数</th>
                            <th className="py-2 font-semibold">金额</th>
                          </tr>
                        </thead>
                        <tbody>
                          {drawFaces.map((line) => (
                            <tr key={line.key} className="border-t border-[var(--km-border)]">
                              <td className="py-2">{shortTime(line.occurredAt)}</td>
                              <td className="py-2 font-mono text-xs">{line.orderNo}</td>
                              <td className="py-2">{line.title || "—"}</td>
                              <td className="py-2">{line.count}</td>
                              <td className="py-2">{formatYuan(line.amountCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-3 text-xs text-[var(--km-fg-muted)]">共 {drawCount} 张。</p>
                    </>
                  ) : (
                    <p className="text-sm text-[var(--km-fg-muted)]">{waitingSheet || !preview ? "加载中…" : "没有未结算的提卡。"}</p>
                  )
                ) : null}
                {detail === "history" ? (
                  settled.length ? (
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs text-[var(--km-fg-muted)]">
                          <th className="py-2 font-semibold">时间</th>
                          <th className="py-2 font-semibold">单号</th>
                          <th className="py-2 font-semibold">方向</th>
                          <th className="py-2 font-semibold">方式</th>
                          <th className="py-2 font-semibold">流水号</th>
                          <th className="py-2 font-semibold">金额</th>
                        </tr>
                      </thead>
                      <tbody>
                        {settled.map((row) => (
                          <tr key={row.id} className="border-t border-[var(--km-border)]">
                            <td className="py-2">{shortTime(row.paidAt || row.createdAt)}</td>
                            <td className="py-2 font-mono text-xs">{row.batchNo}</td>
                            <td className={`py-2 ${netTone(row.netCents)}`}>{youWords(row.netCents)}</td>
                            <td className="py-2">{row.status === "cleared" ? "抵平" : paymentMethodLabel(row.paymentMethod)}</td>
                            <td className="py-2 font-mono text-xs">{row.paymentReference || "—"}</td>
                            <td className="py-2">{formatYuan(row.netCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-sm text-[var(--km-fg-muted)]">还没有结算记录。</p>
                  )
                ) : null}
                {detail === "history" && batchesNext !== null ? (
                  <button
                    type="button"
                    className="km-btn km-btn-ghost km-btn-sm mt-3"
                    onClick={() => selectedId && void loadBatches(selectedId, true, batchesNext)}
                  >
                    更多记录
                  </button>
                ) : null}
              </section>

              {preview?.skipped.length ? (
                <section className="km-panel space-y-2">
                  <h2 className="text-base font-semibold">不进这次的 {preview.skipped.length} 笔</h2>
                  <p className="text-xs text-[var(--km-fg-muted)]">手续费尚未核定，或账目不一致。核定后将自动进入下一次未结。</p>
                  <ul className="space-y-1 text-xs">
                    {preview.skipped.map((item, index) => (
                      <li key={skippedKey(item, index)}>
                        <span className="font-mono">{item.orderNo}</span> · {skipCodeLabel(item.code)}
                        {item.amountCents === null ? " · 金额未知" : ` · ${formatYuan(item.amountCents)}`}
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={skippedAcked}
                      onChange={(event) => setAckedKey(event.target.checked ? ackKey : "")}
                    />
                    <span>已核对这 {preview.skipped.length} 笔，本次暂不纳入</span>
                  </label>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function rowFigures(
  row: AgentRow,
  unpaid: { netCents: number; storeEarningCents: number; drawDebtCents: number } | null,
) {
  if (unpaid) return { net: unpaid.netCents, store: unpaid.storeEarningCents, draw: unpaid.drawDebtCents };
  return { net: row.netCents, store: row.storeEarningCents, draw: row.drawDebtCents };
}

function youWords(netCents: number) {
  if (netCents > 0) return "平台应付代理";
  if (netCents < 0) return "代理应付平台";
  return "净额为零";
}

function netTone(netCents: number) {
  if (netCents > 0) return "text-[var(--km-warning)]";
  if (netCents < 0) return "text-[var(--km-success)]";
  return "text-[var(--km-fg-muted)]";
}

function shortTime(value: string | null) {
  const full = formatBeijing(value, "");
  if (!full) return "—";
  return full.length >= 16 ? full.slice(5) : full;
}

function faceFromPreview(item: PreviewItem): Face {
  return {
    key: `${item.type}-${item.id}`,
    type: item.type,
    orderNo: item.orderNo,
    amountCents: item.amountCents,
    occurredAt: item.occurredAt || "",
    title: item.title || "",
    goodsCents: item.goodsCents ?? null,
    feeCents: item.feeCents ?? null,
    count: 1,
  };
}

function faceFromBatch(item: BatchItem): Face {
  const snapshot = item.snapshot || {};
  const text = (key: string) => (typeof snapshot[key] === "string" ? snapshot[key] : "");
  const cents = (key: string) => (typeof snapshot[key] === "number" ? snapshot[key] : null);
  return {
    key: `item-${item.id}`,
    type: item.sourceType,
    orderNo: item.sourceOrderNo,
    amountCents: item.amountCents,
    occurredAt: text("occurredAt"),
    title: text("productName") || text("planName") || text("reason") || text("type"),
    goodsCents: cents("goodsCents"),
    feeCents: cents("agentFeeCents"),
    count: 1,
  };
}

function groupDraws(lines: Face[]) {
  const grouped = new Map<string, Face>();
  for (const line of lines) {
    const prev = grouped.get(line.orderNo);
    if (!prev) {
      grouped.set(line.orderNo, { ...line });
      continue;
    }
    prev.amountCents += line.amountCents;
    prev.count += line.count;
  }
  return [...grouped.values()];
}

function downloadCsv(filename: string, rows: string[][]) {
  const text = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value: string) {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
