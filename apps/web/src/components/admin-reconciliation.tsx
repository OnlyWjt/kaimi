"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { BatchPanel, type WriteFn, type WriteInput } from "@/components/admin-reconciliation-batch";
import {
  apiCall,
  Formula,
  LinesTable,
  NetText,
  NoticeBar,
  StatusBadge,
  TypeTabs,
  viewOf,
  type AgentListData,
  type AgentRow,
  type BatchDetail,
  type BatchListData,
  type BatchRow,
  type Notice,
  type Preview,
} from "@/components/admin-reconciliation-shared";
import {
  formatBeijing,
  formatSignedYuan,
  formatYuan,
  isActiveBatchStatus,
  isUnpaidBatchStatus,
  parseLocked,
  reuseOrCreateKey,
  skipCodeLabel,
  skippedAckKey,
  skippedKey,
  statusLabel,
  type ErrorAction,
  type IdemEntry,
} from "@/lib/admin-reconciliation-ui";

type Tab = "preview" | "batch" | "history";

const PREVIEW_PAGE = 50;

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
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("net");
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<AgentListData["summary"]>({
    openAgents: 0,
    platformPaysCents: 0,
    agentPaysCents: 0,
    reviewOrders: 0,
  });
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(0);
  const [selectedName, setSelectedName] = useState("");
  const [tab, setTab] = useState<Tab>("preview");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewType, setPreviewType] = useState("");
  const [previewShown, setPreviewShown] = useState(PREVIEW_PAGE);
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
  const filtersRef = useRef({ search, status, sort });
  useEffect(() => {
    filtersRef.current = { search, status, sort };
  }, [search, status, sort]);

  const loadList = useCallback(async (nextCutoff: string, append = false, cursor = "") => {
    setListLoading(true);
    const { search: q, status: s, sort: o } = filtersRef.current;
    const params = new URLSearchParams({ search: q, status: s, sort: o, limit: "50" });
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
    setSummary(result.data.summary);
    setRows((current) => (append ? [...current, ...result.data.list] : result.data.list));
    setNextCursor(result.data.nextCursor);
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
    setPreviewType("");
    setPreviewShown(PREVIEW_PAGE);
    setAckedKey("");
    setNotice(null);
    const [, opened] = await Promise.all([loadPreview(row.agentId, cutoffAt), restoreBatch(row.agentId, true)]);
    if (selectedRef.current !== row.agentId) return;
    setTab(opened && isActiveBatchStatus(opened.status) ? "batch" : "preview");
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
          const recovered = await restoreBatch(agentId, true);
          if (selectedRef.current === agentId) {
            if (recovered && isActiveBatchStatus(recovered.status)) setTab("batch");
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
      if (fresh.status === "cancelled") {
        delete openBatchRef.current[fresh.agentId];
      }
    }
    if (agentId) {
      const data = await loadList(cutoffAt);
      await Promise.all([loadPreview(agentId, data?.cutoffAt || cutoffAt), loadBatches(agentId)]);
    }
  }

  async function createBatch() {
    if (!preview || !preview.items.length) return;
    if (preview.skipped.length && !skippedAcked) return;
    const body: Record<string, unknown> = {
      agentId: preview.agentId,
      cutoffAt: preview.cutoffAt,
      previewVersion: preview.previewVersion,
      items: preview.items.map((item) => ({ type: item.type, id: item.id, version: item.version })),
    };
    if (preview.skipped.length && skippedAcked) {
      body.acknowledgedSkipped = preview.skipped.map((item) => item.orderNo);
    }
    const result = await write({
      op: "create",
      scope: `agent${preview.agentId}-${preview.previewVersion}`,
      url: "/api/admin/reconciliations",
      method: "POST",
      body,
      stage: "create",
    });
    if (!result?.ok) return;
    const data = result.data as { id: number; batchNo: string };
    const agentId = preview.agentId;
    openBatchRef.current[agentId] = data.id;
    await loadBatch(data.id);
    setTab("batch");
    setNotice({ kind: "ok", text: `已生成 ${data.batchNo}（待核对），请看下方明细后确认` });
    const list = await loadList(cutoffAt);
    await Promise.all([loadPreview(agentId, list?.cutoffAt || cutoffAt), loadBatches(agentId)]);
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
        setTab("batch");
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
      setTab("preview");
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
      if (agentId) void loadPreview(agentId, cutoffAt).then(() => setTab("preview"));
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

  const selected = rows.find((row) => row.agentId === selectedId) || null;
  const agentName = selected?.name || selectedName || (selectedId ? `代理 ${selectedId}` : "");
  const previewLines = (preview?.items || []).filter((item) => !previewType || item.type === previewType);
  const locked = preview ? parseLocked(preview) : null;
  const ackKey = preview ? skippedAckKey(preview.previewVersion, preview.cutoffAt, preview.skipped) : "";
  const skippedAcked = Boolean(preview?.skipped.length) && ackedKey === ackKey;
  const canCreate =
    Boolean(preview && preview.items.length) && (!preview?.skipped.length || skippedAcked) && !busy;

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-[var(--km-fg-muted)]">
            可对账净额，不含待核对项。截止 {cutoffAt ? formatBeijing(cutoffAt) : "…"}（北京时间），不按周划分。
          </p>
          <h1 className="mt-1 text-2xl font-semibold">对账</h1>
        </div>
        <button type="button" className="km-btn" disabled={busy || listLoading} onClick={() => void refreshToNow()}>
          刷新到现在
        </button>
      </div>

      {notice ? (
        <NoticeBar
          notice={notice}
          actionLabel={notice.action ? ACTION_LABELS[notice.action] : undefined}
          onAction={notice.action ? () => runNoticeAction(notice.action as ErrorAction) : undefined}
          onClose={() => setNotice(null)}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="km-stat">
          <p className="text-xs text-[var(--km-fg-muted)]">待生成代理</p>
          <p className="km-stat-value">{summary.openAgents}</p>
        </div>
        <div className="km-stat">
          <p className="text-xs text-[var(--km-fg-muted)]">平台应付代理（合计）</p>
          <p className="km-stat-value">{formatYuan(summary.platformPaysCents)}</p>
        </div>
        <div className="km-stat">
          <p className="text-xs text-[var(--km-fg-muted)]">代理应付平台（合计）</p>
          <p className="km-stat-value">{formatYuan(summary.agentPaysCents)}</p>
        </div>
        <div className="km-stat">
          <p className="text-xs text-[var(--km-fg-muted)]">待核对订单</p>
          <p className="km-stat-value">{summary.reviewOrders}</p>
        </div>
      </div>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void loadList(cutoffAt);
        }}
      >
        <input
          className="km-input max-w-xs"
          placeholder="搜索代理"
          aria-label="搜索代理"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="km-input w-36" aria-label="状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部</option>
          <option value="balance">有余额</option>
          <option value="pending_payment">有待处理批次</option>
          <option value="cleared">已清</option>
          <option value="review">待核对</option>
        </select>
        <select className="km-input w-36" aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="net">按净额</option>
          <option value="updated">按更新</option>
          <option value="name">按名称</option>
        </select>
        <button type="submit" className="km-btn km-btn-ghost" disabled={listLoading}>
          筛选
        </button>
      </form>

      <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <section className="km-panel space-y-2" aria-label="代理列表">
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.agentId}>
                <button
                  type="button"
                  aria-pressed={row.agentId === selectedId}
                  className={`w-full rounded-xl border p-3 text-left text-sm transition ${
                    row.agentId === selectedId
                      ? "border-[var(--km-accent)] bg-[var(--km-bg-muted)]"
                      : "border-[var(--km-border)] hover:bg-[var(--km-bg-muted)]"
                  }`}
                  onClick={() => void selectAgent(row)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <b className="min-w-0 truncate">{row.name}</b>
                    <NetText netCents={row.netCents} className="text-right text-xs" />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--km-fg-muted)]">
                    商店 {formatSignedYuan(row.storeEarningCents)} ＋ 调整 {formatSignedYuan(row.adjustmentCents)} − 提卡{" "}
                    {formatSignedYuan(row.drawDebtCents)}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--km-fg-muted)]">
                    <span>明细 {row.itemCount}</span>
                    <span className={row.skippedCount ? "text-[var(--km-warning)]" : ""}>异常 {row.skippedCount}</span>
                    {row.lockedNetCents ? (
                      <span>
                        已锁定{" "}
                        {row.lockedNetCents > 0 ? "平台应付代理" : "代理应付平台"} {formatYuan(row.lockedNetCents)}
                      </span>
                    ) : null}
                  </p>
                  {row.latestBatch ? (
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono text-[var(--km-fg-muted)]">{row.latestBatch.batchNo}</span>
                      <StatusBadge status={row.latestBatch.status} />
                    </p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {!rows.length && !listLoading ? <p className="py-4 text-sm text-[var(--km-fg-muted)]">这个筛选下没有代理。</p> : null}
          {listLoading ? <p className="text-xs text-[var(--km-fg-muted)]">加载中…</p> : null}
          {nextCursor ? (
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm w-full"
              disabled={listLoading}
              onClick={() => void loadList(cutoffAt, true, nextCursor)}
            >
              加载更多代理
            </button>
          ) : null}
        </section>

        <section className="km-panel min-w-0 space-y-3 text-sm" aria-label="代理详情">
          {!selectedId ? <p className="text-[var(--km-fg-muted)]">先选一个代理。</p> : null}
          {selectedId ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-semibold">{agentName}</h2>
                <div className="flex gap-1" role="tablist" aria-label="详情视图">
                  {(
                    [
                      ["preview", "未结预览"],
                      ["batch", batch ? `批次 ${batch.batchNo}` : "批次"],
                      ["history", `历史${batches.length ? ` ${batches.length}` : ""}`],
                    ] as Array<[Tab, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={tab === value}
                      className={`km-btn km-btn-sm ${tab === value ? "" : "km-btn-ghost"}`}
                      onClick={() => setTab(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {tab === "preview" ? (
                preview ? (
                  <div className="space-y-3">
                    <p className="text-xs text-[var(--km-fg-muted)]">
                      {preview.note}。截止 {formatBeijing(preview.cutoffAt)}（北京时间）。
                    </p>
                    <NetText netCents={preview.totals.netCents} className="block text-xl" />
                    <Formula value={preview.totals} />
                    {locked ? (
                      <LockedNotice
                        locked={locked}
                        batchNoOf={(id) => batches.find((row) => row.id === id)?.batchNo || ""}
                        onOpenBatch={(ids) => void openBatchByIds(ids)}
                      />
                    ) : null}
                    {preview.skipped.length ? (
                      <div className="space-y-2 rounded-xl border border-[var(--km-warning)] p-3">
                        <p className="font-medium">
                          待核对 {preview.skipped.length} 笔，不进这次批次
                          {preview.skippedUnknownCount ? `（其中 ${preview.skippedUnknownCount} 笔金额未知）` : ""}
                        </p>
                        <ul className="space-y-1 text-xs">
                          {preview.skipped.map((item, index) => (
                            <li key={skippedKey(item, index)} className="flex flex-wrap gap-x-2">
                              <span className="font-mono">{item.orderNo}</span>
                              <span>{skipCodeLabel(item.code)}</span>
                              <span className="text-[var(--km-fg-muted)]">{item.message || ""}</span>
                              <span>{item.amountCents === null ? "金额未知" : formatSignedYuan(item.amountCents)}</span>
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
                          <span>我已核对这 {preview.skipped.length} 笔，暂不纳入本批次</span>
                        </label>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="km-btn" disabled={!canCreate} onClick={() => void createBatch()}>
                        生成批次（{preview.items.length} 笔）
                      </button>
                      {!preview.items.length ? <span className="text-xs text-[var(--km-fg-muted)]">没有可纳入的未结明细</span> : null}
                      {preview.items.length && preview.skipped.length && !skippedAcked ? (
                        <span className="text-xs text-[var(--km-warning)]">先勾选确认待核对项</span>
                      ) : null}
                    </div>

                    <TypeTabs
                      value={previewType}
                      onChange={(value) => {
                        setPreviewType(value);
                        setPreviewShown(PREVIEW_PAGE);
                      }}
                      counts={{
                        "": preview.items.length,
                        earning: preview.items.filter((item) => item.type === "earning").length,
                        adjustment: preview.items.filter((item) => item.type === "adjustment").length,
                        draw_item: preview.items.filter((item) => item.type === "draw_item").length,
                      }}
                    />
                    <LinesTable
                      lines={previewLines.slice(0, previewShown).map((item) => ({
                        key: `${item.type}-${item.id}`,
                        type: item.type,
                        orderNo: item.orderNo,
                        amountCents: item.amountCents,
                      }))}
                    />
                    {previewLines.length > previewShown ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost km-btn-sm"
                        onClick={() => setPreviewShown((value) => value + PREVIEW_PAGE)}
                      >
                        再显示 {Math.min(PREVIEW_PAGE, previewLines.length - previewShown)} 条（共 {previewLines.length}）
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[var(--km-fg-muted)]">加载预览…</p>
                )
              ) : null}

              {tab === "batch" ? (
                batch ? (
                  <BatchPanel
                    key={batch.id}
                    batch={batch}
                    agentName={agentName}
                    busy={busy}
                    write={write}
                    ask={ask}
                    onChanged={onBatchChanged}
                    itemsVersion={itemsVersion}
                  />
                ) : (
                  <p className="text-[var(--km-fg-muted)]">没有正在处理的批次。在「未结预览」生成，或在「历史」里打开旧批次。</p>
                )
              ) : null}

              {tab === "history" ? (
                <div className="space-y-2">
                  {!batches.length ? <p className="text-[var(--km-fg-muted)]">这个代理还没有批次。</p> : null}
                  <ul className="space-y-2">
                    {batches.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          className={`w-full rounded-xl border p-3 text-left text-xs ${
                            batch?.id === row.id ? "border-[var(--km-accent)]" : "border-[var(--km-border)]"
                          }`}
                          onClick={() => {
                            openBatchRef.current[row.agentId] = row.id;
                            void loadBatch(row.id).then((found) => found && setTab("batch"));
                          }}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono text-sm">{row.batchNo}</span>
                            <StatusBadge status={row.status} />
                          </div>
                          <NetText netCents={row.netCents} className="mt-1 block text-sm" />
                          <p className="mt-1 text-[var(--km-fg-muted)]">
                            截止 {formatBeijing(row.cutoffAt)} · 生成 {formatBeijing(row.createdAt)}
                            {row.paidAt ? ` · 结算 ${formatBeijing(row.paidAt)}` : ""}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {batchesNext !== null ? (
                    <button
                      type="button"
                      className="km-btn km-btn-ghost km-btn-sm w-full"
                      onClick={() => selectedId && void loadBatches(selectedId, true, batchesNext)}
                    >
                      加载更多批次
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function netWords(netCents: number) {
  if (netCents === 0) return "抵平 ¥0.00";
  return `${netCents > 0 ? "平台应付代理" : "代理应付平台"} ${formatYuan(netCents)}`;
}

/** 锁定来源分开讲：对账批次里待处理 / 旧周结单里。旧后端没有拆分字段时只显示合计，不给「打开批次」。 */
function LockedNotice({
  locked,
  batchNoOf,
  onOpenBatch,
}: {
  locked: ReturnType<typeof parseLocked>;
  batchNoOf: (id: number) => string;
  onOpenBatch: (ids: number[]) => void;
}) {
  const box = "flex flex-wrap items-center gap-2 rounded-xl bg-[var(--km-bg-muted)] px-3 py-2 text-xs";
  if (locked.legacyShape) {
    if (!locked.total) return null;
    return (
      <div className={box}>
        <span>
          另有 {locked.total.itemCount} 笔已被占用（{netWords(locked.total.netCents)}），不重复计算。
        </span>
      </div>
    );
  }
  return (
    <>
      {locked.inBatch ? (
        <div className={box}>
          <span>
            {locked.inBatch.itemCount} 笔、{netWords(locked.inBatch.netCents)} 已在对账批次{" "}
            {locked.inBatch.batchIds.map((id) => batchNoOf(id) || `#${id}`).join("、")} 中待处理，不重复计算。
          </span>
          {locked.inBatch.batchIds.length ? (
            <button type="button" className="km-btn km-btn-sm" onClick={() => onOpenBatch(locked.inBatch!.batchIds)}>
              打开批次
            </button>
          ) : null}
        </div>
      ) : null}
      {locked.legacy ? (
        <div className={box}>
          <span>
            {locked.legacy.itemCount} 笔、{netWords(locked.legacy.netCents)} 在旧周结单{" "}
            {locked.legacy.settlementNos.length ? locked.legacy.settlementNos.join("、") : ""}
            中，请到「历史周结」核验后再对账。
          </span>
          <a className="km-btn km-btn-sm" href="/admin#week">
            去历史周结
          </a>
        </div>
      ) : null}
    </>
  );
}