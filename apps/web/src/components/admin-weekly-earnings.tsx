"use client";

import { Fragment, useEffect, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { adminStatusLabel } from "@/lib/status-labels";
import { beijingMondayYmd, beijingWeekBounds, recentWeekMondays } from "@/lib/beijing-week";

type Settlement = {
  id: number;
  settlementNo: string;
  agentName: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  status: string;
  settlementPayee?: string;
  settlementMethod?: string;
  settlementAccount?: string;
};

type EarningLine = {
  orderNo: string;
  productName: string;
  goodsCents: number;
  agentFeeCents: number;
  earningCents: number;
};

type HeldOrder = { orderNo: string; agentName: string; reason: string };
type AuditIssue = {
  orderNo: string;
  agent: string;
  kinds: string[];
  settlementNo?: string | null;
  expected?: { agentEarningCents?: number };
  stored?: { agentEarningCents?: number };
};

function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`;
}

export function AdminWeeklyEarnings() {
  const weeks = recentWeekMondays(6);
  const current = beijingMondayYmd();
  const [week, setWeek] = useState(weeks[1] || weeks[0]);
  const [rows, setRows] = useState<Settlement[]>([]);
  const [openId, setOpenId] = useState(0);
  const [lines, setLines] = useState<EarningLine[]>([]);
  const [message, setMessage] = useState("");
  const [payId, setPayId] = useState(0);
  const [method, setMethod] = useState("支付宝");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<HeldOrder[]>([]);
  const [audit, setAudit] = useState<{ scanned: number; ok: number; issues: AuditIssue[] } | null>(null);
  const { ask, dialog } = useAskDialog();

  async function load() {
    const response = await fetch("/api/admin/settlements", { cache: "no-store" });
    const data = await response.json();
    if (response.ok) setRows(data.list || []);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const closed = await fetch("/api/admin/settlements/close-week", { method: "POST" });
      const data = await closed.json().catch(() => ({}));
      if (!cancelled && data.failed?.length) {
        setMessage("上一周有代理没结上，服务会再试。下面列出还没进单的订单。");
      } else if (!cancelled && data.created?.length) {
        setMessage(`已自动生成上一周 ${data.created.length} 张结算单`);
      }
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (week === current) {
      setHeld([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/admin/settlements/close-week?week=${week}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setHeld(data.held || []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [week, current]);

  const bounds = beijingWeekBounds(week);
  const locked = week === current;
  const visible = rows.filter((row) => row.periodStart === bounds.start && row.periodEnd === bounds.end);
  const payable = visible.filter((row) => row.status === "pending_payment").reduce((sum, row) => sum + row.amountCents, 0);
  const paid = visible.filter((row) => row.status === "paid").reduce((sum, row) => sum + row.amountCents, 0);

  async function openItems(row: Settlement) {
    if (openId === row.id) {
      setOpenId(0);
      return;
    }
    const response = await fetch(`/api/admin/settlements/${row.id}/items`);
    const data = await response.json();
    setLines(data.earnings || []);
    setOpenId(row.id);
  }

  async function markPaid(row: Settlement) {
    if (!reference.trim()) {
      setMessage("填写打款流水号后再标记");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/settlements/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_paid", paymentMethod: method, paymentReference: reference.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || "标记失败");
        return;
      }
      setPayId(0);
      setReference("");
      setMessage(`${row.agentName} 已标记打款`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function postJson(url: string, body?: unknown, method = "POST") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(url, {
        method,
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

  async function recalculateFees(releaseSettlements = false) {
    const data = await postJson("/api/admin/earnings/recalculate", { releaseSettlements });
    if (!data) return;
    const blocking = data.blockingSettlements || [];
    if (blocking.length && !releaseSettlements) {
      const ok = await ask({
        title: "先撤销占用中的结算单？",
        message: `有 ${blocking.length} 张待打款结算单占着要改的收益。撤销后会按当前费率重算，已打款的不动。`,
        confirmLabel: "撤销并重算",
        danger: true,
      });
      if (ok) {
        await recalculateFees(true);
        return;
      }
    }
    setMessage(`已重算 ${data.updated} 笔（扫描 ${data.scanned} 笔）`);
  }

  function issueLabel(kind: string) {
    if (kind === "formula_mismatch") return "公式对不上";
    if (kind === "order_earning_row_mismatch") return "订单和收益行不一致";
    if (kind === "fee_anomalous") return "手续费异常";
    if (kind === "low_earning") return "收益低于 1 元";
    return kind;
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-[var(--km-fg-muted)]">北京时间每周一自动结算上一周。不用再点生成。</p>
        <h1 className="mt-1 text-2xl font-semibold">每周收益</h1>
      </div>
      {message ? <div className="km-panel text-sm">{message}</div> : null}
      <div className="flex flex-wrap gap-2">
        {weeks.map((item) => {
          const label = beijingWeekBounds(item);
          return (
            <button
              key={item}
              type="button"
              className={`rounded-2xl border px-3 py-2 text-left ${week === item ? "border-[var(--km-fg)]" : "border-[var(--km-border)]"}`}
              onClick={() => setWeek(item)}
            >
              <b className="block text-sm">{label.label}</b>
              <span className="text-xs text-[var(--km-fg-muted)]">{item === current ? "进行中" : "已结束"}</span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-[var(--km-fg-muted)]">一周是周一 00:00 到周日 24:00。收益按订单当时记下的手续费算，之后改费率不会改旧周。</p>
      {locked ? (
        <div className="km-panel text-sm">这一周还没结束。周日夜里过后会自动出打款单。</div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="km-stat"><p className="text-xs text-[var(--km-fg-muted)]">本周待打款</p><p className="km-stat-value">{yuan(payable)}</p></div>
            <div className="km-stat"><p className="text-xs text-[var(--km-fg-muted)]">已打款</p><p className="km-stat-value">{yuan(paid)}</p></div>
            <div className="km-stat"><p className="text-xs text-[var(--km-fg-muted)]">代理</p><p className="km-stat-value">{visible.length}</p></div>
          </div>
          <section className="km-panel overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)]">
                  <th className="py-2 pr-3">代理</th>
                  <th className="py-2 pr-3">结算单</th>
                  <th className="py-2 pr-3">代理收益</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-[var(--km-fg-muted)]">这一周没有待打款的代理。对不上的订单会留到后面的周，不进这张单。</td>
                  </tr>
                ) : null}
                {visible.map((row) => (
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
                      <td className="py-3 pr-3">{yuan(row.amountCents)}</td>
                      <td className="py-3 pr-3 whitespace-nowrap">{adminStatusLabel(row.status, "settlement")}</td>
                      <td className="py-3 whitespace-nowrap">
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => void openItems(row)}>
                          {openId === row.id ? "收起" : "明细"}
                        </button>
                        {row.status === "pending_payment" ? (
                          <button type="button" className="km-btn km-btn-ghost km-btn-sm ml-2" onClick={() => setPayId(payId === row.id ? 0 : row.id)}>
                            标记已打款
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {payId === row.id ? (
                      <tr>
                        <td colSpan={5} className="bg-[var(--km-bg-muted)] px-3 py-3">
                          <div className="flex flex-wrap items-end gap-2 text-sm">
                            <label>方式<input className="km-input ml-2 w-32" value={method} onChange={(event) => setMethod(event.target.value)} /></label>
                            <label>流水号<input className="km-input ml-2 w-48" value={reference} onChange={(event) => setReference(event.target.value)} /></label>
                            <button type="button" className="km-btn km-btn-sm" disabled={busy} onClick={() => void markPaid(row)}>确认</button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {openId === row.id ? (
                      <tr>
                        <td colSpan={5} className="bg-[var(--km-bg-muted)] px-3 py-3">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="text-[var(--km-fg-muted)]">
                                <th className="py-1 pr-3">订单</th>
                                <th className="py-1 pr-3">套餐</th>
                                <th className="py-1 pr-3">货款</th>
                                <th className="py-1 pr-3">手续费</th>
                                <th className="py-1">代理收益</th>
                              </tr>
                            </thead>
                            <tbody>
                              {lines.map((line) => (
                                <tr key={line.orderNo} className="border-t border-[var(--km-border)]">
                                  <td className="py-2 pr-3 font-mono">{line.orderNo}</td>
                                  <td className="py-2 pr-3">{line.productName}</td>
                                  <td className="py-2 pr-3">{yuan(line.goodsCents)}</td>
                                  <td className="py-2 pr-3">{yuan(line.agentFeeCents)}</td>
                                  <td className="py-2">{yuan(line.earningCents)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </section>
          {held.length ? (
            <section className="km-panel space-y-2 text-sm">
              <h2 className="font-semibold">这周没自动进去的 {held.length} 笔</h2>
              <p className="text-[var(--km-fg-muted)]">处理完会进下一次结算。已经生成的单不重算。出单失败的代理会自动再试。</p>
              {held.map((item) => (
                <p key={item.orderNo}>{item.orderNo} · {item.agentName} · {item.reason}</p>
              ))}
            </section>
          ) : null}
        </>
      )}
      <section className="km-panel space-y-3 text-sm">
        <h2 className="font-semibold">手续费与核对</h2>
        <p className="text-[var(--km-fg-muted)]">改过费率后，先重算还没进结算单的手续费，再核对。已打款的单不会改。</p>
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
