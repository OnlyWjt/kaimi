"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "@/components/toast";
import { yuanTextFromCents, centsFromYuanText } from "@/lib/money";
import { DrawCodePeek } from "@/components/draw-code-peek";
import { KmSelect } from "@/components/km-select";
import { RegionBadge } from "@/components/region-badge";
import {
  DRAW_PAYMENT_METHODS,
  creditHeat,
  drawCodeUseLabel,
  formatYuan,
  summarizeDrawItems,
} from "@/lib/agent-draw-core";
import { hasNextPage, pageLabel } from "@/lib/pagination-core";

type LedgerAgent = {
  agentId: number;
  name: string;
  drawStatus: string;
  creditLimitCents: number;
  unsettledCount: number;
  unsettledCents: number;
  settledCount?: number;
  settledCents?: number;
  lifetimeCount?: number;
  lifetimeCents?: number;
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
  manualUsedAt?: string;
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

type BillFilter = {
  agentId: number;
  query: string;
  method: string;
  status: string;
  from: string;
  to: string;
};

const EMPTY_BILL_FILTER: BillFilter = { agentId: 0, query: "", method: "", status: "", from: "", to: "" };

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

function billSearch(bills: BillFilter, page = 1) {
  const params = new URLSearchParams();
  if (bills.agentId > 0) params.set("billAgentId", String(bills.agentId));
  if (bills.query.trim()) params.set("q", bills.query.trim());
  if (bills.method) params.set("method", bills.method);
  if (bills.status) params.set("billStatus", bills.status);
  if (bills.from) params.set("from", bills.from);
  if (bills.to) params.set("to", bills.to);
  params.set("page", String(page));
  return params;
}

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--km-fg-muted)]">
      <span>{pageLabel(total, page, 20)}</span>
      <div className="flex gap-2">
        <button type="button" className="km-btn km-btn-ghost km-btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </button>
        <button
          type="button"
          className="km-btn km-btn-ghost km-btn-sm"
          disabled={!hasNextPage(total, page, 20)}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-xs font-medium text-[var(--km-fg-muted)]">
      {label}
      {hint ? <span className="ml-1 font-normal">{hint}</span> : null}
      <span className="mt-1 block text-sm font-normal text-[var(--km-fg)]">{children}</span>
    </label>
  );
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
  const [manualTarget, setManualTarget] = useState<LedgerItem | null>(null);
  const [manualReason, setManualReason] = useState("");
  const [voidMode, setVoidMode] = useState<"upstream" | "local">("upstream");
  const [voidReason, setVoidReason] = useState("");
  const [suffixes, setSuffixes] = useState<Record<number, string>>({});
  const [billDetail, setBillDetail] = useState<{
    id: number;
    billNo: string;
    notes?: string;
    items: LedgerItem[];
  } | null>(null);
  const [itemQuery, setItemQuery] = useState("");
  const [billDraft, setBillDraft] = useState<BillFilter>(EMPTY_BILL_FILTER);
  const [billFilter, setBillFilter] = useState<BillFilter>(EMPTY_BILL_FILTER);
  const [billTotal, setBillTotal] = useState(0);
  const [billPage, setBillPage] = useState(1);
  const [itemTotal, setItemTotal] = useState(0);
  const [itemPage, setItemPage] = useState(1);
  const [busy, setBusy] = useState("");

  async function load(agentId = selectedId, page = itemPage) {
    const params = new URLSearchParams();
    if (agentId > 0) params.set("agentId", String(agentId));
    params.set("itemPage", String(page));
    const data = await fetch(`/api/admin/draw?${params}`, { cache: "no-store" }).then((res) => res.json());
    if (data.error) throw new Error(data.error);
    setOverview(data.overview);
    setAgents(data.agents || []);
    setApplications(data.applications || []);
    setItems(data.items || []);
    setItemTotal(Number(data.itemTotal) || 0);
    setItemPage(Number(data.itemPage) || page);
    setStuck(data.stuck || []);
    setChecked((data.items || []).map((item: LedgerItem) => item.id));
    return data;
  }

  async function loadBills(filter: BillFilter, page: number) {
    const data = await fetch(`/api/admin/draw/bills?${billSearch(filter, page)}`, { cache: "no-store" }).then((res) => res.json());
    if (data.error) throw new Error(data.error);
    setBills(data.list || []);
    setBillTotal(Number(data.total) || 0);
    setBillPage(Number(data.page) || page);
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
  const visibleItems = useMemo(() => {
    const query = itemQuery.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      [item.drawNo, item.codeMasked, item.planName].some((value) => value.toLowerCase().includes(query)),
    );
  }, [items, itemQuery]);
  const selectedItems = useMemo(
    () => visibleItems.filter((item) => checked.includes(item.id)),
    [visibleItems, checked],
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
      const data = await load(agentId, 1);
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

  function openBills(next: BillFilter, page = 1) {
    setBillDraft(next);
    setBillFilter(next);
    setBillDetail(null);
    setView("bills");
    setBusy("load");
    void loadBills(next, page)
      .catch((error) => toast(error instanceof Error ? error.message : "查询失败", "err"))
      .finally(() => setBusy(""));
  }

  const billExport = `/api/admin/draw/export?kind=bills&${billSearch(billFilter)}`;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="km-stat">
          <p className="text-xs text-[var(--km-fg-muted)]">待审批</p>
          <p className="km-stat-value">{overview?.pendingApplications ?? "…"}</p>
        </div>
        <div className="km-stat">
          <p className="text-xs text-[var(--km-fg-muted)]">已开通代理</p>
          <p className="km-stat-value">{overview?.approvedAgents ?? "…"}</p>
        </div>
        <div className="km-stat">
          <p className="text-xs text-[var(--km-fg-muted)]">未结算</p>
          <p className="km-stat-value">{overview ? yuan(overview.unsettledCents) : "…"}</p>
          <p className="text-xs text-[var(--km-fg-muted)]">{overview?.unsettledCount ?? 0} 张</p>
        </div>
      </section>

      <div className="km-tabs">
        <button type="button" className={`km-tab ${view === "ledger" ? "km-tab-active" : ""}`} onClick={() => setView("ledger")}>
          未结算账本
        </button>
        <button type="button" className={`km-tab ${view === "bills" ? "km-tab-active" : ""}`} onClick={() => setView("bills")}>
          结算归档
        </button>
        <button type="button" className={`km-tab ${view === "apply" ? "km-tab-active" : ""}`} onClick={() => setView("apply")}>
          申请{applications.length ? ` ${applications.length}` : ""}
        </button>
      </div>

      {view === "apply" ? (
        <section className="km-panel space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full max-w-xs">
              <Field label="直接开通">
                <KmSelect
                  value={grantAgentId ? String(grantAgentId) : ""}
                  placeholder="选择代理"
                  options={[
                    { value: "", label: "选择代理" },
                    ...allAgents.map((agent) => ({ value: String(agent.id), label: agent.displayName })),
                  ]}
                  onChange={(value) => setGrantAgentId(Number(value))}
                />
              </Field>
            </div>
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
        <section className="km-panel space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="代理">
              <KmSelect
                value={billDraft.agentId ? String(billDraft.agentId) : ""}
                placeholder="全部"
                options={[
                  { value: "", label: "全部" },
                  ...agents.map((agent) => ({ value: String(agent.agentId), label: agent.name })),
                ]}
                onChange={(value) => setBillDraft((current) => ({ ...current, agentId: Number(value) }))}
              />
            </Field>
            <Field label="关键词" hint="账单号 / 流水号 / 备注">
              <input
                className="km-input w-full"
                value={billDraft.query}
                placeholder="例如 DB 或流水号"
                onChange={(event) => setBillDraft((current) => ({ ...current, query: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") openBills(billDraft);
                }}
              />
            </Field>
            <Field label="收款方式">
              <KmSelect
                value={billDraft.method}
                placeholder="全部"
                options={[
                  { value: "", label: "全部" },
                  ...DRAW_PAYMENT_METHODS.map((method) => ({ value: method.value, label: method.label })),
                ]}
                onChange={(value) => setBillDraft((current) => ({ ...current, method: value }))}
              />
            </Field>
            <Field label="状态">
              <KmSelect
                value={billDraft.status}
                placeholder="全部"
                options={[
                  { value: "", label: "全部" },
                  { value: "settled", label: "已结算" },
                  { value: "reverted", label: "已撤销" },
                ]}
                onChange={(value) => setBillDraft((current) => ({ ...current, status: value }))}
              />
            </Field>
            <Field label="开始日期">
              <input
                className="km-input w-full"
                type="date"
                value={billDraft.from}
                onChange={(event) => setBillDraft((current) => ({ ...current, from: event.target.value }))}
              />
            </Field>
            <Field label="结束日期">
              <input
                className="km-input w-full"
                type="date"
                value={billDraft.to}
                onChange={(event) => setBillDraft((current) => ({ ...current, to: event.target.value }))}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Pager page={billPage} total={billTotal} onPage={(page) => openBills(billFilter, page)} />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="km-btn km-btn-sm" disabled={Boolean(busy)} onClick={() => openBills(billDraft)}>
                查询
              </button>
              <button
                type="button"
                className="km-btn km-btn-ghost km-btn-sm"
                disabled={Boolean(busy)}
                onClick={() => openBills(EMPTY_BILL_FILTER)}
              >
                清空
              </button>
              <a className="km-btn km-btn-ghost km-btn-sm" href={billExport}>
                导出 CSV
              </a>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)] text-xs text-[var(--km-fg-muted)]">
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
                      没有符合条件的结算记录。
                    </td>
                  </tr>
                ) : null}
                {bills.map((bill) => (
                  <Fragment key={bill.id}>
                  <tr>
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
                        className="km-btn km-btn-ghost km-btn-sm"
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
                          className="km-btn km-btn-ghost km-btn-sm"
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
                  {billDetail?.id === bill.id ? (
                    <tr>
                      <td colSpan={9} className="bg-[var(--km-bg-muted)] px-3 py-3">
                        {billDetail.notes ? (
                          <p className="mb-2 text-xs text-[var(--km-fg-muted)]">备注：{billDetail.notes}</p>
                        ) : null}
                        <table className="w-full min-w-[640px] text-left text-xs">
                          <thead>
                            <tr className="text-[var(--km-fg-muted)]">
                              <th className="py-1 pr-3 font-medium">时间</th>
                              <th className="py-1 pr-3 font-medium">提卡单</th>
                              <th className="py-1 pr-3 font-medium">套餐</th>
                              <th className="py-1 pr-3 font-medium">卡密</th>
                              <th className="py-1 pr-3 font-medium">使用</th>
                              <th className="py-1 font-medium">金额</th>
                            </tr>
                          </thead>
                          <tbody>
                            {billDetail.items.map((item) => (
                              <tr key={item.id} className="border-t border-[var(--km-border)]">
                                <td className="py-2 pr-3">{item.createdAt.slice(5, 16).replace("T", " ")}</td>
                                <td className="py-2 pr-3 font-mono">{item.drawNo}</td>
                                <td className="py-2 pr-3">
                                  {item.planName}
                                  {item.paymentCountry ? <RegionBadge country={item.paymentCountry} /> : null}
                                </td>
                                <td className="py-2 pr-3">
                                  <DrawCodePeek
                                    itemId={item.id}
                                    masked={item.codeMasked}
                                    href={`/api/admin/draw/items/${item.id}`}
                                  />
                                </td>
                                <td className="py-2 pr-3">{drawCodeUseLabel(item.cdkStatus, Boolean(item.manualUsedAt))}</td>
                                <td className="py-2">{yuan(item.amountCents)}</td>
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
          </div>
        </section>
      ) : null}

      {view === "ledger" ? (
        <section className="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="km-panel space-y-1">
            <h2 className="mb-2 font-semibold">代理</h2>
            {agents.length === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">还没有开通提卡的代理。到「申请」里开通。</p>
            ) : (
              agents.map((agent) => (
                <button
                  key={agent.agentId}
                  type="button"
                  className={`block w-full rounded-xl px-3 py-2.5 text-left ${agent.agentId === selectedId ? "bg-[var(--km-bg-muted)]" : "hover:bg-[var(--km-bg-muted)]"}`}
                  onClick={() => void openAgent(agent.agentId)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <b className="truncate text-sm">{agent.name}</b>
                    <span className="shrink-0 text-[11px] text-[var(--km-fg-muted)]">
                      {STATUS[agent.drawStatus] || agent.drawStatus}
                    </span>
                  </span>
                  <span className={`mt-1 block text-xs ${heatClass(agent.unsettledCents, agent.creditLimitCents)}`}>
                    未结 {yuan(agent.unsettledCents)} · {agent.unsettledCount} 张
                  </span>
                  <span className="block text-xs text-[var(--km-fg-muted)]">
                    历史 {yuan(agent.lifetimeCents || 0)} · {agent.lifetimeCount || 0} 张
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
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-semibold">{selected.name}</h2>
                      <span className="rounded-full bg-[var(--km-bg-muted)] px-2 py-0.5 text-xs text-[var(--km-fg-muted)]">
                        {STATUS[selected.drawStatus] || selected.drawStatus}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-2">
                        <p className="text-[11px] text-[var(--km-fg-muted)]">未结</p>
                        <p className={`text-sm font-semibold ${heatClass(selected.unsettledCents, selected.creditLimitCents)}`}>
                          {yuan(selected.unsettledCents)}
                        </p>
                        <p className="text-[11px] text-[var(--km-fg-muted)]">{selected.unsettledCount} 张</p>
                      </div>
                      <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-2">
                        <p className="text-[11px] text-[var(--km-fg-muted)]">已结算</p>
                        <p className="text-sm font-semibold">{yuan(selected.settledCents || 0)}</p>
                        <p className="text-[11px] text-[var(--km-fg-muted)]">{selected.settledCount || 0} 张</p>
                      </div>
                      <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-2">
                        <p className="text-[11px] text-[var(--km-fg-muted)]">历史提卡</p>
                        <p className="text-sm font-semibold">{yuan(selected.lifetimeCents || 0)}</p>
                        <p className="text-[11px] text-[var(--km-fg-muted)]">{selected.lifetimeCount || 0} 张</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a className="km-btn km-btn-ghost km-btn-sm" href={`/api/admin/draw/export?kind=items&agentId=${selected.agentId}`}>
                      导出
                    </a>
                    <button
                      type="button"
                      className="km-btn km-btn-ghost km-btn-sm"
                      onClick={() => openBills({ ...EMPTY_BILL_FILTER, agentId: selected.agentId })}
                    >
                      查结算
                    </button>
                    <button
                      type="button"
                      className="km-btn km-btn-sm"
                      disabled={!selectedItems.length || Boolean(busy)}
                      onClick={() => setSettleOpen(true)}
                    >
                      登记结算{selectedItems.length ? ` ${yuan(selectedCents)}` : ""}
                    </button>
                  </div>
                </div>
                <div className="rounded-2xl border border-[var(--km-border)] p-4">
                  <p className="text-sm font-medium">提卡设置</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Field label="上限" hint="元">
                      <input className="km-input w-full" inputMode="decimal" value={creditYuan} onChange={(event) => setCreditYuan(event.target.value)} />
                    </Field>
                    <Field label="单次最多" hint="张">
                      <input className="km-input w-full" inputMode="numeric" value={maxPerDraw} onChange={(event) => setMaxPerDraw(event.target.value)} />
                    </Field>
                    <Field label="每日最多" hint="0 = 不限">
                      <input className="km-input w-full" inputMode="numeric" value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} />
                    </Field>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={notifyEach} onChange={(event) => setNotifyEach(event.target.checked)} />
                      每次提卡发 Telegram
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="km-btn km-btn-ghost km-btn-sm"
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
                          className="km-btn km-btn-ghost km-btn-sm"
                          disabled={Boolean(busy)}
                          onClick={() => void post({ action: "suspend", agentId: selected.agentId }, "已暂停提卡")}
                        >
                          暂停提卡
                        </button>
                      ) : null}
                      {selected.drawStatus === "suspended" ? (
                        <button
                          type="button"
                          className="km-btn km-btn-ghost km-btn-sm"
                          disabled={Boolean(busy)}
                          onClick={() => void post({ action: "resume", agentId: selected.agentId }, "已恢复提卡")}
                        >
                          恢复提卡
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                {settleOpen ? (
                  <div className="space-y-3 rounded-2xl border border-[var(--km-border)] p-4 text-sm">
                    <p className="font-medium">
                      登记结算 · {selected.name} · {selectedItems.length} 张 · {yuan(selectedCents)}
                    </p>
                    {groups.map((group) => (
                      <p key={`${group.planKey}-${group.unitPriceCents}`} className="text-[var(--km-fg-muted)]">
                        {group.planName} × {group.count} = {yuan(group.amountCents)}
                      </p>
                    ))}
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="收款方式">
                        <KmSelect
                          value={payMethod}
                          options={DRAW_PAYMENT_METHODS.map((method) => ({ value: method.value, label: method.label }))}
                          onChange={setPayMethod}
                        />
                      </Field>
                      <Field label="流水号">
                        <input className="km-input w-full" value={payRef} onChange={(event) => setPayRef(event.target.value)} />
                      </Field>
                      <Field label="备注">
                        <input className="km-input w-full" value={payNotes} onChange={(event) => setPayNotes(event.target.value)} />
                      </Field>
                    </div>
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
                {manualTarget ? (
                  <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
                    <p>
                      手动核销 {manualTarget.codeMasked} · {manualTarget.planName} · {yuan(manualTarget.amountCents)}
                    </p>
                    <p className="text-[var(--km-fg-muted)]">
                      会向卡台退卡。卡密不能再兑换，金额仍算这个代理的未结。
                    </p>
                    <input
                      className="km-input w-full"
                      placeholder="原因，例如已手动充值"
                      value={manualReason}
                      onChange={(event) => setManualReason(event.target.value)}
                    />
                    <div className="flex gap-2">
                      <button type="button" className="km-btn km-btn-ghost" onClick={() => setManualTarget(null)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="km-btn"
                        disabled={Boolean(busy) || !manualReason.trim()}
                        onClick={() => {
                          void post(
                            { action: "manual-use", itemId: manualTarget.id, reason: manualReason },
                            "已手动核销，金额仍在未结里",
                          ).then((ok) => {
                            if (ok) {
                              setManualTarget(null);
                              setManualReason("");
                            }
                          });
                        }}
                      >
                        核销并退卡台
                      </button>
                    </div>
                  </div>
                ) : null}
                {voidTarget ? (
                  <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
                    <p>
                      作废 {voidTarget.codeMasked} · {voidTarget.planName} · {yuan(voidTarget.amountCents)}
                    </p>
                    <p className="text-[var(--km-fg-muted)]">作废后不再计入欠款。误提、退卡才用这个。</p>
                    <label className="block">
                      <input
                        type="radio"
                        checked={voidMode === "upstream"}
                        onChange={() => setVoidMode("upstream")}
                      />{" "}
                      退卡台（删卡退款）
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Field label="筛选未结卡密">
                    <input
                      className="km-input w-64"
                      value={itemQuery}
                      placeholder="单号、卡密或套餐"
                      onChange={(event) => setItemQuery(event.target.value)}
                    />
                  </Field>
                  <p className="text-xs text-[var(--km-fg-muted)]">
                    {visibleItems.length} 张{itemQuery.trim() ? `，已选 ${selectedItems.length} 张` : ""}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--km-border)]">
                        <th className="py-2 pr-3">
                          <input
                            type="checkbox"
                            checked={visibleItems.length > 0 && visibleItems.every((item) => checked.includes(item.id))}
                            onChange={(event) =>
                              setChecked(
                                event.target.checked
                                  ? [...new Set([...checked, ...visibleItems.map((item) => item.id)])]
                                  : checked.filter((id) => !visibleItems.some((item) => item.id === id)),
                              )
                            }
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
                      {visibleItems.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-6 text-[var(--km-fg-muted)]">
                            {items.length === 0 ? "这个代理没有未结算的提卡。" : "没有符合筛选的卡密。"}
                          </td>
                        </tr>
                      ) : null}
                      {visibleItems.map((item) => (
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
                          <td className="py-2 pr-3">
                            <DrawCodePeek
                              itemId={item.id}
                              masked={item.codeMasked}
                              href={`/api/admin/draw/items/${item.id}`}
                            />
                          </td>
                          <td className="py-2 pr-3">{drawCodeUseLabel(item.cdkStatus, Boolean(item.manualUsedAt))}</td>
                          <td className="py-2 pr-3">{yuan(item.amountCents)}</td>
                          <td className="py-2">
                            <div className="flex flex-wrap gap-1">
                              {item.cdkStatus === "unused" && !item.manualUsedAt ? (
                                <button
                                  type="button"
                                  className="km-btn km-btn-ghost km-btn-sm"
                                  onClick={() => {
                                    setManualTarget(item);
                                    setManualReason("");
                                  }}
                                >
                                  手动核销
                                </button>
                              ) : null}
                              {item.cdkStatus === "unused" || item.manualUsedAt ? (
                                <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setVoidTarget(item)}>
                                  作废
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={itemPage} total={itemTotal} onPage={(page) => void load(selected.agentId, page)} />
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
