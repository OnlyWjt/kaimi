"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { yuanTextFromCents, centsFromYuanText } from "@/lib/money";
import { RegionBadge } from "@/components/region-badge";
import {
  CDK_USE_LABEL,
  DRAW_PAYMENT_METHODS,
  creditHeat,
  formatYuan,
  summarizeDrawItems,
} from "@/lib/agent-draw-core";

type LedgerAgent = {
  agentId: number;
  name: string;
  drawStatus: string;
  creditLimitCents: number;
  unsettledCount: number;
  unsettledCents: number;
  maxPerDraw: number;
  dailyLimitCount: number;
  notifyEachDraw: boolean;
};

type LedgerItem = {
  id: number;
  createdAt: string;
  planName: string;
  planKey: string;
  amountCents: number;
  cdkStatus: string;
  paymentCountry: string;
  drawNo: string;
  codeMasked: string;
};

type Application = {
  id: number;
  agentId: number;
  name: string;
  contact: string;
  expectedMonthly: string;
  note: string;
  createdAt: string;
};

type StuckOrder = {
  id: number;
  drawNo: string;
  status: string;
  quantity: number;
  unitPriceCents: number;
  planName: string;
  lastErrorMessage: string;
  attempts: number;
};

type BillRow = {
  id: number;
  billNo: string;
  agentId: number;
  name: string;
  itemCount: number;
  amountCents: number;
  paymentMethodLabel: string;
  paymentReference: string;
  status: string;
  createdAt: string;
  canRevert: boolean;
  notes: string;
};

type Overview = {
  pendingApplications: number;
  approvedAgents: number;
  unsettledCents: number;
  unsettledCount: number;
};

const STATUS: Record<string, string> = {
  approved: "已开通",
  pending: "审核中",
  rejected: "未通过",
  suspended: "已暂停",
  none: "未开通",
};

function yuan(cents: number) {
  return formatYuan(cents);
}

function heatClass(cents: number, limit: number) {
  const ratio = limit > 0 ? cents / limit : cents > 0 ? 1 : 0;
  const heat = creditHeat(ratio);
  if (heat === "full") return "text-red-600";
  if (heat === "warn") return "text-amber-600";
  return "";
}

export function AdminAgentDraw() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [agents, setAgents] = useState<LedgerAgent[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [bills, setBills] = useState<BillRow[]>([]);
  const [allAgents, setAllAgents] = useState<Array<{ id: number; displayName: string }>>([]);
  const [selectedId, setSelectedId] = useState(0);
  const [items, setItems] = useState<LedgerItem[]>([]);
  const [stuck, setStuck] = useState<StuckOrder[]>([]);
  const [checked, setChecked] = useState<number[]>([]);
  const [view, setView] = useState<"ledger" | "bills" | "apply">("ledger");
  const [grantAgentId, setGrantAgentId] = useState(0);
  const [creditYuan, setCreditYuan] = useState("");
  const [maxPerDraw, setMaxPerDraw] = useState("10");
  const [dailyLimit, setDailyLimit] = useState("0");
  const [notifyEach, setNotifyEach] = useState(true);
  const [settleOpen, setSettleOpen] = useState(false);
  const [payMethod, setPayMethod] = useState("alipay");
  const [payRef, setPayRef] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [voidTarget, setVoidTarget] = useState<LedgerItem | null>(null);
  const [voidMode, setVoidMode] = useState<"upstream" | "local">("upstream");
  const [voidReason, setVoidReason] = useState("");
  const [suffixes, setSuffixes] = useState<Record<number, string>>({});
  const [billDetail, setBillDetail] = useState<{
    id: number;
    billNo: string;
    items: LedgerItem[];
  } | null>(null);
  const [busy, setBusy] = useState("");

  async function load(agentId = selectedId) {
    const data = await fetch(`/api/admin/draw?agentId=${agentId}`, { cache: "no-store" }).then((res) => res.json());
    if (data.error) throw new Error(data.error);
    setOverview(data.overview);
    setAgents(data.agents || []);
    setApplications(data.applications || []);
    setItems(data.items || []);
    setStuck(data.stuck || []);
    setBills(data.bills || []);
    setChecked((data.items || []).map((item: LedgerItem) => item.id));
    return data;
  }

  useEffect(() => {
    void load(0).catch((error) => toast(error instanceof Error ? error.message : "加载失败", "err"));
    void fetch("/api/admin/agents", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setAllAgents(data.list || []))
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = agents.find((agent) => agent.agentId === selectedId) || null;
  const selectedItems = useMemo(
    () => items.filter((item) => checked.includes(item.id)),
    [items, checked],
  );
  const selectedCents = selectedItems.reduce((sum, item) => sum + item.amountCents, 0);
  const groups = summarizeDrawItems(
    selectedItems.map((item) => ({
      planKey: item.planKey,
      planName: item.planName,
      amountCents: item.amountCents,
    })),
  );

  function fillSettings(agent: LedgerAgent | undefined) {
    setCreditYuan(agent ? yuanTextFromCents(agent.creditLimitCents) : "");
    setMaxPerDraw(String(agent?.maxPerDraw ?? 10));
    setDailyLimit(String(agent?.dailyLimitCount ?? 0));
    setNotifyEach(agent?.notifyEachDraw ?? true);
  }

  async function openAgent(agentId: number) {
    setSelectedId(agentId);
    setSettleOpen(false);
    setVoidTarget(null);
    setBusy("load");
    try {
      const data = await load(agentId);
      fillSettings((data.agents || []).find((item: LedgerAgent) => item.agentId === agentId));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function post(body: unknown, ok: string) {
    setBusy("post");
    try {
      const response = await fetch("/api/admin/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作失败");
      toast(data.warning ? `${ok}。${data.warning}` : ok, data.warning ? "err" : undefined);
      await load(selectedId);
      if (typeof data.creditLimitCents === "number") {
        setCreditYuan(yuanTextFromCents(data.creditLimitCents));
      }
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", "err");
      return false;
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="km-panel">
          <p className="text-sm text-[var(--km-fg-muted)]">待审批</p>
          <p className="text-2xl font-semibold">{overview?.pendingApplications ?? "…"}</p>
        </div>
        <div className="km-panel">
          <p className="text-sm text-[var(--km-fg-muted)]">已开通代理</p>
          <p className="text-2xl font-semibold">{overview?.approvedAgents ?? "…"}</p>
        </div>
        <div className="km-panel">
          <p className="text-sm text-[var(--km-fg-muted)]">未结算</p>
          <p className="text-2xl font-semibold">{overview ? yuan(overview.unsettledCents) : "…"}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">{overview?.unsettledCount ?? 0} 张</p>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={`km-btn ${view === "ledger" ? "" : "km-btn-ghost"}`} onClick={() => setView("ledger")}>
          未结算账本
        </button>
        <button type="button" className={`km-btn ${view === "bills" ? "" : "km-btn-ghost"}`} onClick={() => setView("bills")}>
          已结算
        </button>
        <button type="button" className={`km-btn ${view === "apply" ? "" : "km-btn-ghost"}`} onClick={() => setView("apply")}>
          申请 {applications.length ? `(${applications.length})` : ""}
        </button>
      </div>

      {view === "apply" ? (
        <section className="km-panel space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              直接开通
              <select
                className="km-input ml-2"
                value={grantAgentId || ""}
                onChange={(event) => setGrantAgentId(Number(event.target.value))}
              >
                <option value="">选择代理</option>
                {allAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="km-btn"
              disabled={!grantAgentId || Boolean(busy)}
              onClick={() => void post({ action: "grant", agentId: grantAgentId }, "已开通，默认上限 ¥3,000")}
            >
              开通提卡
            </button>
          </div>
          {applications.length === 0 ? (
            <p className="text-sm text-[var(--km-fg-muted)]">没有待处理的申请。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--km-border)]">
                    <th className="py-2 pr-3">代理</th>
                    <th className="py-2 pr-3">联系方式</th>
                    <th className="py-2 pr-3">预计用量</th>
                    <th className="py-2 pr-3">说明</th>
                    <th className="py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map((item) => (
                    <tr key={item.id} className="border-b border-[var(--km-border)]">
                      <td className="py-2 pr-3">{item.name}</td>
                      <td className="py-2 pr-3">{item.contact}</td>
                      <td className="py-2 pr-3">{item.expectedMonthly || "—"}</td>
                      <td className="py-2 pr-3">{item.note || "—"}</td>
                      <td className="py-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="km-btn km-btn-ghost"
                            disabled={Boolean(busy)}
                            onClick={() => void post({ action: "grant", agentId: item.agentId }, `${item.name} 已开通`)}
                          >
                            通过
                          </button>
                          <button
                            type="button"
                            className="km-btn km-btn-ghost"
                            disabled={Boolean(busy)}
                            onClick={() => {
                              const reason = window.prompt("拒绝原因，代理能看到") || "";
                              if (!reason.trim()) return;
                              void post({ action: "reject", applicationId: item.id, reason }, "已拒绝");
                            }}
                          >
                            拒绝
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {view === "bills" ? (
        <section className="km-panel space-y-3">
          <div className="flex justify-end">
            <a className="km-btn km-btn-ghost" href="/api/admin/draw/export?kind=bills">
              导出 CSV
            </a>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)]">
                  <th className="py-2 pr-3">账单号</th>
                  <th className="py-2 pr-3">代理</th>
                  <th className="py-2 pr-3">时间</th>
                  <th className="py-2 pr-3">张数</th>
                  <th className="py-2 pr-3">金额</th>
                  <th className="py-2 pr-3">方式</th>
                  <th className="py-2 pr-3">流水号</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {bills.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-6 text-[var(--km-fg-muted)]">
                      还没有结算账单。
                    </td>
                  </tr>
                ) : null}
                {bills.map((bill) => (
                  <tr key={bill.id} className="border-b border-[var(--km-border)]">
                    <td className="py-2 pr-3 font-mono text-xs">{bill.billNo}</td>
                    <td className="py-2 pr-3">{bill.name}</td>
                    <td className="py-2 pr-3">{bill.createdAt.slice(5, 16).replace("T", " ")}</td>
                    <td className="py-2 pr-3">{bill.itemCount}</td>
                    <td className="py-2 pr-3">{yuan(bill.amountCents)}</td>
                    <td className="py-2 pr-3">{bill.paymentMethodLabel}</td>
                    <td className="py-2 pr-3">{bill.paymentReference || "—"}</td>
                    <td className={`py-2 pr-3 ${bill.status === "reverted" ? "text-[var(--km-fg-muted)]" : ""}`}>
                      {bill.status === "reverted" ? "已撤销" : "已结算"}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() => {
                          if (billDetail?.id === bill.id) {
                            setBillDetail(null);
                            return;
                          }
                          void fetch(`/api/admin/draw?billId=${bill.id}`, { cache: "no-store" })
                            .then((res) => res.json())
                            .then((data) => {
                              if (data.bill) setBillDetail(data.bill);
                            })
                            .catch(() => toast("加载明细失败", "err"));
                        }}
                      >
                        {billDetail?.id === bill.id ? "收起" : "明细"}
                      </button>
                      {bill.canRevert ? (
                        <button
                          type="button"
                          className="km-btn km-btn-ghost"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            const reason = window.prompt("撤销原因") || "";
                            if (!reason.trim()) return;
                            void post({ action: "revert-bill", billId: bill.id, reason }, "已撤销，这些卡回到未结算");
                          }}
                        >
                          撤销
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {billDetail ? (
                  <tr>
                    <td colSpan={9} className="bg-[var(--km-bg-muted)] px-3 py-2 text-xs">
                      {billDetail.billNo}：
                      {billDetail.items.map((item) => (
                        <span key={item.id} className="mr-3 inline-block">
                          {item.codeMasked} · {item.planName} · {yuan(item.amountCents)}
                        </span>
                      ))}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {view === "ledger" ? (
        <section className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <div className="km-panel space-y-2">
            <h2 className="font-semibold">代理</h2>
            {agents.length === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">还没有开通提卡的代理。到「申请」里开通。</p>
            ) : (
              agents.map((agent) => (
                <button
                  key={agent.agentId}
                  type="button"
                  className={`block w-full rounded-xl px-3 py-2 text-left text-sm ${agent.agentId === selectedId ? "bg-[var(--km-bg-muted)]" : ""}`}
                  onClick={() => void openAgent(agent.agentId)}
                >
                  <b>{agent.name}</b>
                  <span className={`mt-1 block text-xs ${heatClass(agent.unsettledCents, agent.creditLimitCents)}`}>
                    {STATUS[agent.drawStatus] || agent.drawStatus} · 未结 {yuan(agent.unsettledCents)} / 上限{" "}
                    {yuan(agent.creditLimitCents)}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="km-panel space-y-3">
            {selected ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{selected.name}</h2>
                    <p className={`text-sm ${heatClass(selected.unsettledCents, selected.creditLimitCents)}`}>
                      未结 {yuan(selected.unsettledCents)} / 上限 {yuan(selected.creditLimitCents)} · {selected.unsettledCount} 张
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a className="km-btn km-btn-ghost" href={`/api/admin/draw/export?kind=items&agentId=${selected.agentId}`}>
                      导出 CSV
                    </a>
                    <button
                      type="button"
                      className="km-btn"
                      disabled={!selectedItems.length || Boolean(busy)}
                      onClick={() => setSettleOpen(true)}
                    >
                      登记结算 {selectedItems.length ? yuan(selectedCents) : ""}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
                  <p className="font-medium">提卡设置</p>
                  <div className="flex flex-wrap items-end gap-3">
                    <label>
                      上限 ¥
                      <input className="km-input ml-1 w-28" value={creditYuan} onChange={(event) => setCreditYuan(event.target.value)} />
                    </label>
                    <label>
                      单次最多
                      <input className="km-input ml-1 w-20" value={maxPerDraw} onChange={(event) => setMaxPerDraw(event.target.value)} /> 张
                    </label>
                    <label>
                      每日最多
                      <input className="km-input ml-1 w-20" value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} /> 张
                      <span className="ml-1 text-xs text-[var(--km-fg-muted)]">0 = 不限</span>
                    </label>
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={notifyEach} onChange={(event) => setNotifyEach(event.target.checked)} />
                      每次提卡发 Telegram
                    </label>
                    <button
                      type="button"
                      className="km-btn km-btn-ghost"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        const cents = centsFromYuanText(creditYuan);
                        const per = Number(maxPerDraw);
                        const daily = Number(dailyLimit);
                        if (cents == null || cents <= 0) {
                          toast("请填写大于 0 的上限", "err");
                          return;
                        }
                        void post(
                          {
                            action: "settings",
                            agentId: selected.agentId,
                            creditLimitCents: cents,
                            maxPerDraw: per,
                            dailyLimitCount: daily,
                            notifyEachDraw: notifyEach,
                          },
                          "提卡设置已保存",
                        );
                      }}
                    >
                      保存设置
                    </button>
                    {selected.drawStatus === "approved" ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={Boolean(busy)}
                        onClick={() => void post({ action: "suspend", agentId: selected.agentId }, "已暂停提卡")}
                      >
                        暂停提卡
                      </button>
                    ) : null}
                    {selected.drawStatus === "suspended" ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={Boolean(busy)}
                        onClick={() => void post({ action: "resume", agentId: selected.agentId }, "已恢复提卡")}
                      >
                        恢复提卡
                      </button>
                    ) : null}
                  </div>
                </div>
                {settleOpen ? (
                  <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
                    <p className="font-medium">
                      登记结算 · {selected.name} · {selectedItems.length} 张 · {yuan(selectedCents)}
                    </p>
                    {groups.map((group) => (
                      <p key={`${group.planKey}-${group.unitPriceCents}`}>
                        {group.planName} × {group.count} = {yuan(group.amountCents)}
                      </p>
                    ))}
                    <label className="block">
                      收款方式
                      <select className="km-input ml-2" value={payMethod} onChange={(event) => setPayMethod(event.target.value)}>
                        {DRAW_PAYMENT_METHODS.map((method) => (
                          <option key={method.value} value={method.value}>
                            {method.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      流水号
                      <input className="km-input ml-2 w-64" value={payRef} onChange={(event) => setPayRef(event.target.value)} />
                    </label>
                    <label className="block">
                      备注
                      <input className="km-input ml-2 w-64" value={payNotes} onChange={(event) => setPayNotes(event.target.value)} />
                    </label>
                    <div className="flex gap-2">
                      <button type="button" className="km-btn km-btn-ghost" onClick={() => setSettleOpen(false)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="km-btn"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          void post(
                            {
                              action: "settle",
                              agentId: selected.agentId,
                              itemIds: selectedItems.map((item) => item.id),
                              expectedAmountCents: selectedCents,
                              paymentMethod: payMethod,
                              paymentReference: payRef,
                              notes: payNotes,
                            },
                            `已结算 ${selectedItems.length} 张，${yuan(selectedCents)}`,
                          ).then((ok) => {
                            if (ok) {
                              setSettleOpen(false);
                              setPayRef("");
                              setPayNotes("");
                            }
                          });
                        }}
                      >
                        确认已收到 {yuan(selectedCents)}
                      </button>
                    </div>
                  </div>
                ) : null}
                {stuck.length ? (
                  <div className="space-y-2 text-sm">
                    {stuck.map((order) => (
                      <div key={order.id} className="rounded-xl border border-amber-300 p-3">
                        <p>
                          {order.drawNo} · {order.planName} × {order.quantity} · {yuan(order.unitPriceCents * order.quantity)}{" "}
                          还占着额度
                          {order.lastErrorMessage ? `（${order.lastErrorMessage}）` : ""}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="km-btn km-btn-ghost"
                            disabled={Boolean(busy)}
                            onClick={() => void post({ action: "recover", orderId: order.id }, "已向卡台取回")}
                          >
                            向卡台取回
                          </button>
                          <input
                            className="km-input w-24"
                            placeholder="单号后四位"
                            value={suffixes[order.id] || ""}
                            onChange={(event) =>
                              setSuffixes((current) => ({ ...current, [order.id]: event.target.value }))
                            }
                          />
                          <button
                            type="button"
                            className="km-btn km-btn-ghost"
                            disabled={Boolean(busy) || order.attempts < 2 || (suffixes[order.id] || "").trim().length < 4}
                            onClick={() =>
                              void post(
                                {
                                  action: "mark-failed",
                                  orderId: order.id,
                                  confirmSuffix: suffixes[order.id] || "",
                                },
                                "已确认没出卡，额度已释放",
                              )
                            }
                          >
                            确认没出卡
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {voidTarget ? (
                  <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
                    <p>
                      作废 {voidTarget.codeMasked} · {voidTarget.planName} · {yuan(voidTarget.amountCents)}
                    </p>
                    <p className="text-[var(--km-fg-muted)]">作废后不再计入欠款。</p>
                    <label className="block">
                      <input
                        type="radio"
                        checked={voidMode === "upstream"}
                        onChange={() => setVoidMode("upstream")}
                      />{" "}
                      同时在卡台删卡退款
                    </label>
                    <label className="block">
                      <input type="radio" checked={voidMode === "local"} onChange={() => setVoidMode("local")} />{" "}
                      只在本系统作废（卡台已手动处理过）
                    </label>
                    <input
                      className="km-input w-full"
                      placeholder="原因"
                      value={voidReason}
                      onChange={(event) => setVoidReason(event.target.value)}
                    />
                    <div className="flex gap-2">
                      <button type="button" className="km-btn km-btn-ghost" onClick={() => setVoidTarget(null)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="km-btn"
                        disabled={Boolean(busy) || !voidReason.trim()}
                        onClick={() => {
                          void post(
                            {
                              action: "void-item",
                              itemId: voidTarget.id,
                              mode: voidMode,
                              reason: voidReason,
                            },
                            "已作废",
                          ).then((ok) => {
                            if (ok) {
                              setVoidTarget(null);
                              setVoidReason("");
                            }
                          });
                        }}
                      >
                        作废
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--km-border)]">
                        <th className="py-2 pr-3">
                          <input
                            type="checkbox"
                            checked={items.length > 0 && checked.length === items.length}
                            onChange={(event) => setChecked(event.target.checked ? items.map((item) => item.id) : [])}
                          />
                        </th>
                        <th className="py-2 pr-3">时间</th>
                        <th className="py-2 pr-3">提卡单</th>
                        <th className="py-2 pr-3">套餐</th>
                        <th className="py-2 pr-3">卡密</th>
                        <th className="py-2 pr-3">使用</th>
                        <th className="py-2 pr-3">金额</th>
                        <th className="py-2">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-6 text-[var(--km-fg-muted)]">
                            这个代理没有未结算的提卡。
                          </td>
                        </tr>
                      ) : null}
                      {items.map((item) => (
                        <tr key={item.id} className="border-b border-[var(--km-border)]">
                          <td className="py-2 pr-3">
                            <input
                              type="checkbox"
                              checked={checked.includes(item.id)}
                              onChange={(event) =>
                                setChecked((current) =>
                                  event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                                )
                              }
                            />
                          </td>
                          <td className="py-2 pr-3">{item.createdAt.slice(5, 16).replace("T", " ")}</td>
                          <td className="py-2 pr-3 font-mono text-xs">{item.drawNo}</td>
                          <td className="py-2 pr-3">
                            {item.planName}
                            {item.paymentCountry ? <RegionBadge country={item.paymentCountry} /> : null}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">{item.codeMasked}</td>
                          <td className="py-2 pr-3">{CDK_USE_LABEL[item.cdkStatus] || item.cdkStatus}</td>
                          <td className="py-2 pr-3">{yuan(item.amountCents)}</td>
                          <td className="py-2">
                            {item.cdkStatus === "unused" ? (
                              <button type="button" className="km-btn km-btn-ghost" onClick={() => setVoidTarget(item)}>
                                作废
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-sm text-[var(--km-fg-muted)]">左边选一个代理，看他提了还没结的卡。</p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
