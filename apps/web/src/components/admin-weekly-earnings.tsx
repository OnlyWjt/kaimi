"use client";

import { Fragment, useEffect, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { adminStatusLabel } from "@/lib/status-labels";
import { formatYuan } from "@/lib/agent-draw-core";
import { parseDbDate } from "@/lib/datetime";

type Settlement = {
  id: number;
  settlementNo: string;
  agentId: number;
  agentName: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  status: string;
  settlementPayee?: string;
  settlementMethod?: string;
  settlementAccount?: string;
  paymentMethod?: string;
  paymentReference?: string;
  createdAt?: string;
  paidAt?: string | null;
};

type EarningLine = {
  orderNo: string;
  productName: string;
  goodsCents: number;
  agentFeeCents: number;
  earningCents: number;
};

type AdjustmentLine = { orderNo: string; type: string; amountCents: number; reason?: string };

type AuditIssue = {
  orderNo: string;
  agent: string;
  kinds: string[];
  settlementNo?: string | null;
  expected?: { agentEarningCents?: number };
  stored?: { agentEarningCents?: number };
};

const RECONCILE_HREF = "/admin#reconcile";

/** 千分位、两位小数，负数保留负号。 */
function yuan(cents: number) {
  return formatYuan(Math.trunc(Number(cents) || 0));
}

/** 与 PATCH 路由的 zod 上限一致，超过会被拒绝为「请求参数无效」。 */
const METHOD_MAX = 64;
const REFERENCE_MAX = 128;

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 北京时间 yyyy-MM-dd HH:mm。不用 toLocaleString，避免跟随浏览器时区和语言。认不出来的值原样返回。 */
function when(value?: string | null) {
  if (!value) return "—";
  const date = parseDbDate(value);
  if (!date) return value;
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/**
 * 对账付款/抵平会写一行 settlement_no = batch_no 的镜像（前缀 RC）。
 * GET /api/admin/settlements 不返回关联字段，这里按编号前缀标注；真正的拦截在 PATCH 路由里按 batch_no 查。
 */
function isReconcileMirror(row: Settlement) {
  return row.settlementNo.startsWith("RC");
}

function goReconcile() {
  window.location.href = RECONCILE_HREF;
}

export function AdminWeeklyEarnings() {
  const [rows, setRows] = useState<Settlement[]>([]);
  const [openId, setOpenId] = useState(0);
  const [lines, setLines] = useState<EarningLine[]>([]);
  const [adjustments, setAdjustments] = useState<AdjustmentLine[]>([]);
  const [message, setMessage] = useState("");
  const [payId, setPayId] = useState(0);
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<{ scanned: number; ok: number; issues: AuditIssue[] } | null>(null);
  const { ask, dialog } = useAskDialog();

  async function load() {
    const response = await fetch("/api/admin/settlements", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (response.ok) setRows(data.list || []);
    else setMessage(data.error || "加载失败");
  }

  useEffect(() => {
    void load();
  }, []);

  const pending = rows.filter(
    (row) => !isReconcileMirror(row) && (row.status === "pending_payment" || row.status === "draft"),
  );
  const history = rows.filter((row) => !pending.includes(row));
  const pendingCents = pending.reduce((sum, row) => sum + row.amountCents, 0);

  async function fetchItems(row: Settlement) {
    const response = await fetch(`/api/admin/settlements/${row.id}/items`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "明细加载失败");
    return {
      earnings: (data.earnings || []) as EarningLine[],
      adjustments: (data.adjustments || []) as AdjustmentLine[],
    };
  }

  async function openItems(row: Settlement) {
    if (openId === row.id) {
      setOpenId(0);
      return;
    }
    try {
      const data = await fetchItems(row);
      setLines(data.earnings);
      setAdjustments(data.adjustments);
      setOpenId(row.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "明细加载失败");
    }
  }

  async function patch(row: Settlement, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/settlements/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(data.error || "操作失败");
        return null;
      }
      return data;
    } finally {
      setBusy(false);
    }
  }

  async function markPaid(row: Settlement) {
    const paymentMethod = method.trim();
    const paymentReference = reference.trim();
    if (!paymentMethod || !paymentReference) {
      setMessage("付款方式和流水号都要填");
      return;
    }
    if (paymentMethod.length > METHOD_MAX || paymentReference.length > REFERENCE_MAX) {
      setMessage(`付款方式最多 ${METHOD_MAX} 个字，流水号最多 ${REFERENCE_MAX} 个字`);
      return;
    }
    const ok = await ask({
      title: `补登 ${row.settlementNo}`,
      message: `确认这张旧单已线下付款 ${yuan(row.amountCents)}？补登后不会再进入新对账。\n代理：${row.agentName}\n方式：${paymentMethod}\n流水：${paymentReference}`,
      confirmLabel: "确认补登",
    });
    if (!ok) return;
    const data = await patch(row, { action: "mark_paid", paymentMethod, paymentReference });
    if (!data) return;
    setPayId(0);
    setMethod("");
    setReference("");
    setMessage(`${row.agentName} 的 ${row.settlementNo} 已补登为已付`);
    await load();
  }

  async function cancelLegacy(row: Settlement) {
    let count: number;
    try {
      const data = await fetchItems(row);
      count = data.earnings.length + data.adjustments.length;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "明细加载失败");
      return;
    }
    const ok = await ask({
      title: `退回 ${row.settlementNo}`,
      message: `确认这张旧单没有付款？取消后其中 ${count} 笔收益回到未结，会进入新对账。\n代理：${row.agentName}\n金额：${yuan(row.amountCents)}`,
      confirmLabel: "确认没付，退回",
      danger: true,
    });
    if (!ok) return;
    const data = await patch(row, { action: "cancel" });
    if (!data) return;
    setMessage(`${row.settlementNo} 已取消，收益回到未结，请到「对账」结清`);
    await load();
  }

  async function postJson(url: string, body?: unknown, httpMethod = "POST") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(url, {
        method: httpMethod,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "操作失败");
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function runAudit() {
    const data = await postJson("/api/admin/earnings/audit", undefined, "GET");
    if (!data) return;
    setAudit(data);
    setMessage(`核对了 ${data.scanned} 笔已支付订单，${data.issues?.length || 0} 笔需要看`);
  }

  async function recalculateFees() {
    // 不再一键撤销占用中的旧单：旧待返佣必须逐张核验，避免把已线下付过的单退回导致重付。
    const data = await postJson("/api/admin/earnings/recalculate", { releaseSettlements: false });
    if (!data) return;
    const blocking: Array<{ settlementNo: string }> = data.blockingSettlements || [];
    setMessage(
      `已重算 ${data.updated} 笔（扫描 ${data.scanned} 笔）` +
        (blocking.length
          ? `。${blocking.length} 张旧待返佣单占着收益没改：${blocking.map((item) => item.settlementNo).join("、")}，请先在上面逐张核验`
          : ""),
    );
  }

  function issueLabel(kind: string) {
    if (kind === "formula_mismatch") return "公式对不上";
    if (kind === "order_earning_row_mismatch") return "订单和收益行不一致";
    if (kind === "fee_anomalous") return "手续费异常";
    if (kind === "low_earning") return "收益低于 1 元";
    return kind;
  }

  function detailRow(row: Settlement) {
    if (openId !== row.id) return null;
    return (
      <tr>
        <td colSpan={6} className="bg-[var(--km-bg-muted)] px-3 py-3">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[var(--km-fg-muted)]">
                <th className="py-1 pr-3">订单</th>
                <th className="py-1 pr-3">套餐 / 调整</th>
                <th className="py-1 pr-3">货款</th>
                <th className="py-1 pr-3">手续费</th>
                <th className="py-1">代理收益</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={`e-${line.orderNo}`} className="border-t border-[var(--km-border)]">
                  <td className="py-2 pr-3 font-mono">{line.orderNo}</td>
                  <td className="py-2 pr-3">{line.productName}</td>
                  <td className="py-2 pr-3">{yuan(line.goodsCents)}</td>
                  <td className="py-2 pr-3">{yuan(line.agentFeeCents)}</td>
                  <td className="py-2">{yuan(line.earningCents)}</td>
                </tr>
              ))}
              {adjustments.map((line, index) => (
                <tr key={`a-${line.orderNo}-${index}`} className="border-t border-[var(--km-border)]">
                  <td className="py-2 pr-3 font-mono">{line.orderNo}</td>
                  <td className="py-2 pr-3">调整 {line.type}{line.reason ? ` · ${line.reason}` : ""}</td>
                  <td className="py-2 pr-3">—</td>
                  <td className="py-2 pr-3">—</td>
                  <td className="py-2">{yuan(line.amountCents)}</td>
                </tr>
              ))}
              {!lines.length && !adjustments.length ? (
                <tr>
                  <td colSpan={5} className="py-2 text-[var(--km-fg-muted)]">没有明细</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">历史周结</h1>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            周结已停用。新的商店收益和提卡请到「对账」按代理结清。
          </p>
        </div>
        <a className="km-btn" href={RECONCILE_HREF}>
          去对账
        </a>
      </div>
      {message ? <div className="km-panel text-sm">{message}</div> : null}

      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">旧待返佣，需逐张核验</h2>
          <span className="text-sm text-[var(--km-fg-muted)]">
            {pending.length} 张 · {yuan(pendingCents)}
          </span>
        </div>
        <p className="text-sm text-[var(--km-fg-muted)]">
          按线下转账凭证一张张核对：已经付过的补登方式和流水；确认没付的取消，收益回到未结，再到「对账」统一结清。不确定的先别动。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">代理</th>
                <th className="py-2 pr-3">单号</th>
                <th className="py-2 pr-3">金额</th>
                <th className="py-2 pr-3">生成时间</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-[var(--km-fg-muted)]">没有待核验的旧单。</td>
                </tr>
              ) : null}
              {pending.map((row) => (
                <Fragment key={row.id}>
                  <tr className="border-b border-[var(--km-border)]">
                    <td className="py-3 pr-3">
                      <div className="font-medium">{row.agentName}</div>
                      {row.settlementAccount ? (
                        <div className="text-xs text-[var(--km-fg-muted)]">
                          {row.settlementPayee || "收款"} {row.settlementMethod} {row.settlementAccount}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3 font-mono text-xs">{row.settlementNo}</td>
                    <td className={`py-3 pr-3 ${row.amountCents < 0 ? "text-red-600" : ""}`}>{yuan(row.amountCents)}</td>
                    <td className="py-3 pr-3 whitespace-nowrap">{when(row.createdAt)}</td>
                    <td className="py-3 pr-3 whitespace-nowrap">{adminStatusLabel(row.status, "settlement")}</td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => void openItems(row)}>
                          {openId === row.id ? "收起" : "明细"}
                        </button>
                        {row.status === "pending_payment" ? (
                          <>
                            <button
                              type="button"
                              className="km-btn km-btn-ghost km-btn-sm"
                              disabled={busy}
                              onClick={() => {
                                setPayId(payId === row.id ? 0 : row.id);
                                setMethod("");
                                setReference("");
                              }}
                            >
                              已线下付过，补登
                            </button>
                            <button
                              type="button"
                              className="km-btn km-btn-ghost km-btn-sm text-[var(--km-danger)]"
                              disabled={busy}
                              onClick={() => void cancelLegacy(row)}
                            >
                              确认没付，退回对账
                            </button>
                          </>
                        ) : (
                          // draft 还没出付款单，不能标已付，只能取消并把占用的收益退回未结。
                          <button
                            type="button"
                            className="km-btn km-btn-ghost km-btn-sm text-[var(--km-danger)]"
                            disabled={busy}
                            onClick={() => void cancelLegacy(row)}
                          >
                            取消并退回对账
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {payId === row.id ? (
                    <tr>
                      <td colSpan={6} className="bg-[var(--km-bg-muted)] px-3 py-3">
                        <div className="flex flex-wrap items-end gap-2 text-sm">
                          <label>
                            付款方式
                            <input
                              className="km-input ml-2 w-36"
                              placeholder="支付宝 / 银行转账"
                              maxLength={METHOD_MAX}
                              value={method}
                              onChange={(event) => setMethod(event.target.value)}
                            />
                            {method.length >= METHOD_MAX ? (
                              <span className="ml-2 text-xs text-[var(--km-danger)]">最多 {METHOD_MAX} 个字，已到上限</span>
                            ) : null}
                          </label>
                          <label>
                            流水号
                            <input
                              className="km-input ml-2 w-56"
                              maxLength={REFERENCE_MAX}
                              value={reference}
                              onChange={(event) => setReference(event.target.value)}
                            />
                            {reference.length >= REFERENCE_MAX ? (
                              <span className="ml-2 text-xs text-[var(--km-danger)]">最多 {REFERENCE_MAX} 个字，已到上限</span>
                            ) : null}
                          </label>
                          <button
                            type="button"
                            className="km-btn km-btn-sm"
                            disabled={busy || !method.trim() || !reference.trim()}
                            onClick={() => void markPaid(row)}
                          >
                            补登已付 {yuan(row.amountCents)}
                          </button>
                          <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setPayId(0)}>
                            取消
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {detailRow(row)}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="km-panel space-y-3">
        <h2 className="font-semibold">历史记录（只读）</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          已付、已取消的旧周结单只做查看。标「对账批次」的是新对账登记时留的记录，到「对账」里看和处理。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">代理</th>
                <th className="py-2 pr-3">单号</th>
                <th className="py-2 pr-3">金额</th>
                <th className="py-2 pr-3">时间</th>
                <th className="py-2 pr-3">状态 / 付款</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-[var(--km-fg-muted)]">没有历史记录。</td>
                </tr>
              ) : null}
              {history.map((row) => {
                const mirror = isReconcileMirror(row);
                return (
                  <Fragment key={row.id}>
                    <tr className="border-b border-[var(--km-border)]">
                      <td className="py-3 pr-3 font-medium">{row.agentName}</td>
                      <td className="py-3 pr-3 font-mono text-xs">
                        {row.settlementNo}
                        {mirror ? <span className="km-badge ml-2">对账批次</span> : null}
                      </td>
                      <td className={`py-3 pr-3 ${row.amountCents < 0 ? "text-red-600" : ""}`}>{yuan(row.amountCents)}</td>
                      <td className="py-3 pr-3 whitespace-nowrap text-xs">
                        <div>生成 {when(row.createdAt)}</div>
                        {row.paidAt ? <div className="text-[var(--km-fg-muted)]">付款 {when(row.paidAt)}</div> : null}
                      </td>
                      <td className="py-3 pr-3 text-xs">
                        <div>{adminStatusLabel(row.status, "settlement")}</div>
                        {row.paymentReference ? (
                          <div className="text-[var(--km-fg-muted)]">
                            {row.paymentMethod} {row.paymentReference}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-3 whitespace-nowrap">
                        {mirror ? (
                          <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={goReconcile}>
                            去对账
                          </button>
                        ) : (
                          <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => void openItems(row)}>
                            {openId === row.id ? "收起" : "明细"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {mirror ? null : detailRow(row)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="km-panel space-y-3 text-sm">
        <h2 className="font-semibold">手续费与核对</h2>
        <p className="text-[var(--km-fg-muted)]">
          改过费率后，先重算还没结的手续费，再核对。已付的不会改；被旧待返佣单占着的收益要先在上面核验完。
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void recalculateFees()}>按当前费率重算未结算手续费</button>
          <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void runAudit()}>收益核对</button>
        </div>
        {audit?.issues.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--km-border)]">
                  <th className="py-1 pr-3">订单</th>
                  <th className="py-1 pr-3">代理</th>
                  <th className="py-1 pr-3">问题</th>
                  <th className="py-1">操作</th>
                </tr>
              </thead>
              <tbody>
                {audit.issues.map((issue) => (
                  <tr key={issue.orderNo} className="border-b border-[var(--km-border)]">
                    <td className="py-2 pr-3 font-mono">{issue.orderNo}</td>
                    <td className="py-2 pr-3">{issue.agent}</td>
                    <td className="py-2 pr-3">{issue.kinds.map(issueLabel).join("、")}</td>
                    <td className="py-2">
                      {issue.kinds.includes("fee_anomalous") ? (
                        <>
                          <button type="button" className="km-btn km-btn-ghost km-btn-sm" disabled={busy} onClick={() => void postJson(`/api/admin/store-orders/${encodeURIComponent(issue.orderNo)}/fee-review`, { decision: "accept_gateway" }).then((data) => data && runAudit())}>采用网关值</button>
                          <button type="button" className="km-btn km-btn-ghost km-btn-sm" disabled={busy} onClick={() => void postJson(`/api/admin/store-orders/${encodeURIComponent(issue.orderNo)}/fee-review`, { decision: "keep_estimate" }).then((data) => data && runAudit())}>保留估算</button>
                        </>
                      ) : null}
                      {issue.kinds.some((kind) => kind !== "low_earning" && kind !== "fee_anomalous") ? (
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm" disabled={busy} onClick={() => void postJson("/api/admin/earnings/audit", { orderNo: issue.orderNo }).then((data) => data && runAudit())}>按快照修正</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {dialog}
    </div>
  );
}
