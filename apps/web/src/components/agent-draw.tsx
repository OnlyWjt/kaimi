"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/toast";
import { KmSelect } from "@/components/km-select";
import { RegionBadge } from "@/components/region-badge";
import {
  CDK_USE_LABEL,
  DRAW_ORDER_LABEL,
  creditHeat,
  formatYuan,
} from "@/lib/agent-draw-core";
import { yuanTextFromCents } from "@/lib/money";

type DrawPlan = {
  planKey: string;
  name: string;
  unitPriceCents: number;
  paymentCountry?: string;
};

type DrawGroup = {
  planName: string;
  count: number;
  amountCents: number;
  unitPriceCents: number;
};

type DrawState = {
  status: string;
  notice: string;
  rejectReason?: string;
  canDraw?: boolean;
  credit?: {
    availableCents: number;
    limitCents: number;
    unsettledCents: number;
    exposureCents: number;
  };
  summary?: { count: number; amountCents: number; groups: DrawGroup[] };
  statementText?: string;
  limits?: { maxPerDraw: number; dailyLimit: number; todayCount: number };
  plans?: DrawPlan[];
  application?: { contact: string; status: string; createdAt: string } | null;
};

type LedgerItem = {
  id: number;
  createdAt: string;
  planName: string;
  amountCents: number;
  cdkStatus: string;
  paymentCountry: string;
  drawNo: string;
  codeMasked: string;
};

type DrawOrderRow = {
  drawNo: string;
  status: string;
  planName: string;
  quantity: number;
  issuedCount: number;
  unitPriceCents: number;
  createdAt: string;
};

type BillRow = {
  billNo: string;
  itemCount: number;
  amountCents: number;
  paymentMethodLabel: string;
  status: string;
  createdAt: string;
};

function stamp(iso: string) {
  return iso.slice(5, 16).replace("T", " ");
}

export function AgentDraw() {
  const [state, setState] = useState<DrawState | null>(null);
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  const [planKey, setPlanKey] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [tab, setTab] = useState<"open" | "orders" | "bills">("open");
  const [items, setItems] = useState<LedgerItem[]>([]);
  const [orders, setOrders] = useState<DrawOrderRow[]>([]);
  const [bills, setBills] = useState<BillRow[]>([]);
  const [openCodes, setOpenCodes] = useState<Record<string, string[]>>({});
  const [openBill, setOpenBill] = useState<string>("");
  const [billItems, setBillItems] = useState<LedgerItem[]>([]);
  const requestId = useRef("");

  async function load() {
    const response = await fetch("/api/agent/draw", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "加载失败");
    setState(data);
    if (!planKey && data.plans?.[0]) setPlanKey(data.plans[0].planKey);
  }

  useEffect(() => {
    void load().catch((error) => toast(error instanceof Error ? error.message : "加载失败", "err"));
  }, []);

  useEffect(() => {
    if (!state || (state.status !== "approved" && state.status !== "suspended")) return;
    const url =
      tab === "open"
        ? "/api/agent/draw/items"
        : tab === "orders"
          ? "/api/agent/draw/orders"
          : "/api/agent/draw/bills";
    void fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (tab === "open") setItems(data.items || []);
        if (tab === "orders") setOrders(data.orders || []);
        if (tab === "bills") setBills(data.bills || []);
      })
      .catch(() => null);
  }, [tab, state]);

  async function apply() {
    setBusy(true);
    try {
      const response = await fetch("/api/agent/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", contact, expectedMonthly: "", note }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "申请失败");
      toast("申请已提交");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "申请失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function draw() {
    const plan = state?.plans?.find((item) => item.planKey === planKey);
    if (!plan) return;
    if (
      !window.confirm(
        `确认提 ${plan.name} × ${quantity}，合计 ¥${yuanTextFromCents(plan.unitPriceCents * quantity)}？提了就计入未结算。`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      if (!requestId.current) requestId.current = crypto.randomUUID();
      const response = await fetch("/api/agent/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "draw",
          requestId: requestId.current,
          planKey,
          quantity,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "提卡失败");
      if (data.status === "failed") {
        requestId.current = "";
        throw new Error(data.message || "卡台没有出卡，没有扣额度");
      }
      if (data.status === "unknown" || data.status === "issuing") {
        throw new Error(data.message || "卡台还没返回结果，没有重复扣费。再点一次会取回同一笔。");
      }
      requestId.current = "";
      setCodes(data.codes || []);
      toast(`已生成 ${data.issuedCount} 张`);
      await load();
      setTab("open");
    } catch (error) {
      toast(error instanceof Error ? error.message : "提卡失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function showOrder(drawNo: string) {
    if (openCodes[drawNo]) {
      setOpenCodes((current) => {
        const next = { ...current };
        delete next[drawNo];
        return next;
      });
      return;
    }
    const response = await fetch(`/api/agent/draw/orders/${encodeURIComponent(drawNo)}`, {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "加载失败", "err");
      return;
    }
    setOpenCodes((current) => ({ ...current, [drawNo]: data.codes || [] }));
  }

  async function showBill(billNo: string) {
    if (openBill === billNo) {
      setOpenBill("");
      return;
    }
    const response = await fetch(`/api/agent/draw/bills/${encodeURIComponent(billNo)}`, {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "加载失败", "err");
      return;
    }
    setOpenBill(billNo);
    setBillItems(data.items || []);
  }

  if (!state) return <p className="text-sm text-[var(--km-fg-muted)]">加载中…</p>;

  if (state.status !== "approved" && state.status !== "suspended") {
    return (
      <section className="km-panel space-y-3">
        <h1 className="text-xl font-semibold">自助提卡</h1>
        {state.status === "pending" ? (
          <p>申请已提交，等平台联系你。联系方式：{state.application?.contact}</p>
        ) : (
          <>
            <p className="text-sm text-[var(--km-fg-muted)]">
              开通后可以直接从平台拿卡密，按成本记账，定期和平台结算。
            </p>
            {state.rejectReason ? <p>上次未通过：{state.rejectReason}</p> : null}
            <label className="block text-sm">
              联系方式
              <input
                className="km-input mt-1 w-full"
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                placeholder="Telegram 用户名"
              />
            </label>
            <label className="block text-sm">
              说明
              <textarea className="km-input mt-1 w-full" value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button type="button" className="km-btn" disabled={busy || !contact.trim()} onClick={() => void apply()}>
              提交申请
            </button>
          </>
        )}
      </section>
    );
  }

  const plan = state.plans?.find((item) => item.planKey === planKey);
  const credit = state.credit;
  const limit = credit?.limitCents || 0;
  const unsettled = credit?.unsettledCents || 0;
  const ratio = limit > 0 ? unsettled / limit : 0;
  const heat = creditHeat(ratio);
  const barClass = heat === "full" ? "bg-red-600" : heat === "warn" ? "bg-amber-500" : "bg-[var(--km-fg)]";
  const textClass = heat === "full" ? "text-red-600" : heat === "warn" ? "text-amber-600" : "";

  return (
    <div className="space-y-4">
      <section className="km-panel space-y-3">
        <h1 className="text-xl font-semibold">自助提卡</h1>
        {state.status === "suspended" ? (
          <p className="text-sm text-amber-700">平台已暂停你的提卡，如有疑问请联系平台。已提的卡仍可对账。</p>
        ) : null}
        {state.notice ? <p className="text-sm">{state.notice}</p> : null}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <p className={`text-sm ${textClass}`}>
            未结 {formatYuan(unsettled)} / 上限 {formatYuan(limit)}
          </p>
          <p className="text-sm">还能提 {formatYuan(credit?.availableCents || 0)}</p>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--km-bg-muted)]">
          <div className={`h-full ${barClass}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
        <p className="text-xs text-[var(--km-fg-muted)]">结算后恢复。转账后请联系平台登记。</p>
        {state.canDraw ? (
          <>
            <label className="block text-sm">
              套餐
              <KmSelect
                className="mt-1"
                value={planKey}
                placeholder="选择套餐"
                options={(state.plans || []).map((item) => ({
                  value: item.planKey,
                  label: `${item.name} · ¥${yuanTextFromCents(item.unitPriceCents)}`,
                }))}
                onChange={setPlanKey}
              />
            </label>
            <label className="block text-sm">
              数量（一次最多 {state.limits?.maxPerDraw ?? 10} 张）
              <input
                className="km-input mt-1 w-32"
                type="number"
                min={1}
                max={state.limits?.maxPerDraw ?? 10}
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value))}
              />
            </label>
            <p>合计 ¥{yuanTextFromCents((plan?.unitPriceCents || 0) * quantity)}</p>
            <button type="button" className="km-btn" disabled={busy || !planKey} onClick={() => void draw()}>
              {busy ? "正在出卡…" : "生成卡密"}
            </button>
          </>
        ) : null}
      </section>
      {codes.length ? (
        <section className="km-panel space-y-2">
          <h2 className="font-semibold">刚生成的卡密</h2>
          {codes.map((code) => (
            <p key={code} className="font-mono text-sm">
              {code}
            </p>
          ))}
          <button
            type="button"
            className="km-btn km-btn-ghost"
            onClick={() => void navigator.clipboard.writeText(codes.join("\n")).then(() => toast("已复制"))}
          >
            复制全部
          </button>
        </section>
      ) : null}
      <section className="km-panel space-y-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`km-btn ${tab === "open" ? "" : "km-btn-ghost"}`} onClick={() => setTab("open")}>
            未结算 ({state.summary?.count ?? 0})
          </button>
          <button type="button" className={`km-btn ${tab === "orders" ? "" : "km-btn-ghost"}`} onClick={() => setTab("orders")}>
            提卡记录
          </button>
          <button type="button" className={`km-btn ${tab === "bills" ? "" : "km-btn-ghost"}`} onClick={() => setTab("bills")}>
            已结算账单
          </button>
        </div>
        {tab === "open" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p>
                未结算 {state.summary?.count ?? 0} 张，合计 {formatYuan(state.summary?.amountCents || 0)}
                {state.summary?.groups?.length
                  ? ` · ${state.summary.groups.map((group) => `${group.planName} × ${group.count} = ${formatYuan(group.amountCents)}`).join(" · ")}`
                  : ""}
              </p>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={!state.statementText}
                onClick={() =>
                  void navigator.clipboard.writeText(state.statementText || "").then(() => toast("对账文本已复制"))
                }
              >
                复制对账文本
              </button>
            </div>
            <ItemTable items={items} empty="当前没有未结算的卡密。" />
          </>
        ) : null}
        {tab === "orders" ? (
          <div className="space-y-2 text-sm">
            {orders.length === 0 ? <p className="text-[var(--km-fg-muted)]">还没有提卡记录。</p> : null}
            {orders.map((order) => (
              <div key={order.drawNo} className="rounded-xl border border-[var(--km-border)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>
                    {stamp(order.createdAt)} · {order.planName} × {order.issuedCount}/{order.quantity} ·{" "}
                    {DRAW_ORDER_LABEL[order.status as keyof typeof DRAW_ORDER_LABEL] || order.status}
                    {order.status === "unknown" || order.status === "issuing" ? "（找回中，额度仍占用）" : ""}
                  </p>
                  <button type="button" className="km-btn km-btn-ghost" onClick={() => void showOrder(order.drawNo)}>
                    {openCodes[order.drawNo] ? "收起" : "查看卡密"}
                  </button>
                </div>
                {openCodes[order.drawNo] ? (
                  <div className="mt-2 space-y-1">
                    {openCodes[order.drawNo].map((code) => (
                      <p key={code} className="font-mono text-xs">
                        {code}
                      </p>
                    ))}
                    <button
                      type="button"
                      className="km-btn km-btn-ghost"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(openCodes[order.drawNo].join("\n"))
                          .then(() => toast("已复制"))
                      }
                    >
                      复制这一单
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {tab === "bills" ? (
          <div className="space-y-2 text-sm">
            {bills.length === 0 ? <p className="text-[var(--km-fg-muted)]">还没有结算账单。</p> : null}
            {bills.map((bill) => (
              <div key={bill.billNo} className="rounded-xl border border-[var(--km-border)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={bill.status === "reverted" ? "text-[var(--km-fg-muted)]" : ""}>
                    {stamp(bill.createdAt)} · {bill.itemCount} 张 · {formatYuan(bill.amountCents)} · {bill.paymentMethodLabel} ·{" "}
                    {bill.status === "reverted" ? "已撤销" : "已结算"}
                  </p>
                  <button type="button" className="km-btn km-btn-ghost" onClick={() => void showBill(bill.billNo)}>
                    {openBill === bill.billNo ? "收起" : "明细"}
                  </button>
                </div>
                {openBill === bill.billNo ? <ItemTable items={billItems} empty="这张账单没有明细。" /> : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ItemTable({ items, empty }: { items: LedgerItem[]; empty: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--km-border)]">
            <th className="py-2 pr-3">时间</th>
            <th className="py-2 pr-3">提卡单</th>
            <th className="py-2 pr-3">套餐</th>
            <th className="py-2 pr-3">卡密</th>
            <th className="py-2 pr-3">使用</th>
            <th className="py-2">金额</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-6 text-[var(--km-fg-muted)]">
                {empty}
              </td>
            </tr>
          ) : null}
          {items.map((item) => (
            <tr key={item.id || `${item.drawNo}-${item.codeMasked}`} className="border-b border-[var(--km-border)]">
              <td className="py-2 pr-3">{stamp(item.createdAt)}</td>
              <td className="py-2 pr-3 font-mono text-xs">{item.drawNo}</td>
              <td className="py-2 pr-3">
                {item.planName}
                {item.paymentCountry ? <RegionBadge country={item.paymentCountry} /> : null}
              </td>
              <td className="py-2 pr-3 font-mono text-xs">{item.codeMasked}</td>
              <td className="py-2 pr-3">{CDK_USE_LABEL[item.cdkStatus] || item.cdkStatus}</td>
              <td className="py-2">{formatYuan(item.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
