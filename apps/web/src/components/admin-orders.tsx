"use client";

import { PlanLabel } from "@/components/plan-label";
import { Fragment, useEffect, useState } from "react";
import { loadAdminSection, postAdminAction } from "@/components/admin-api";
import { AdminDrawOrderDetail } from "@/components/admin-draw-lookup";
import { AdminOrderTimeline } from "@/components/admin-order-timeline";
import { AdminStoreOrders } from "@/components/admin-store-orders";
import { STATUS_LABEL, StatusBadge, formatWhen, kindLabel, progressLabel } from "@/components/admin-ui";
import { KmSelect } from "@/components/km-select";
import { StoreOrderDetail } from "@/components/store-order-detail";
import { toast } from "@/components/toast";

export type AdminOrderKind = "" | "store" | "redeem" | "draw";

const KIND_TABS = [
  ["", "全部"],
  ["store", "店铺订单"],
  ["redeem", "兑换记录"],
  ["draw", "提卡单"],
] as const;

const STATUS_FILTERS = [
  "pending",
  "processing",
  "success",
  "failed",
  "unknown",
  "fulfilled",
  "paid",
  "unpaid",
  "pending_pay",
  "paid_undelivered",
  "issuing",
  "delivered",
  "partially_delivered",
] as const;

type OrdersPage = { list?: Array<Record<string, unknown>>; page?: { next_cursor?: string } };

/**
 * 「日常 › 订单」。全部 / 兑换记录 / 提卡单是只读的合并列表；店铺订单切到 AdminStoreOrders，
 * 补发、退款这些操作只在那里。kind 由外壳控制，这样总览能直接跳到店铺订单。
 */
export function AdminOrders({
  kind,
  onKindChange,
}: {
  kind: AdminOrderKind;
  onKindChange: (next: AdminOrderKind) => void;
}) {
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [nextCursor, setNextCursor] = useState("");
  const [expandedNo, setExpandedNo] = useState("");
  const [busy, setBusy] = useState(false);

  function query(forKind: AdminOrderKind = kind) {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (status) qs.set("status", status);
    if (includeHidden) qs.set("include_hidden", "1");
    if (forKind) qs.set("kind", forKind);
    return qs;
  }

  async function reload(forKind: AdminOrderKind = kind) {
    const data = await loadAdminSection<OrdersPage>("orders", query(forKind).toString());
    setOrders(data?.list || []);
    setNextCursor(data?.page?.next_cursor || "");
  }

  useEffect(() => {
    if (kind !== "store") void reload(kind);
    // 筛选条件改了要点「筛选」才生效，这里只跟着页签切换重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function act(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      return await postAdminAction(payload);
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    const qs = query();
    qs.set("cursor", nextCursor);
    const data = await loadAdminSection<OrdersPage>("orders", qs.toString());
    setOrders((current) => [...current, ...(data?.list || [])]);
    setNextCursor(data?.page?.next_cursor || "");
  }

  return (
    <div className="km-panel overflow-x-auto text-sm">
      <div className="km-tabs mb-3">
        {KIND_TABS.map(([value, label]) => (
          <button
            key={value || "all"}
            type="button"
            className={`km-tab ${kind === value ? "km-tab-active" : ""}`}
            onClick={() => onKindChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === "store" ? (
        <AdminStoreOrders />
      ) : (
        <>
          <div className="km-toolbar">
            <input
              className="km-input max-w-xs"
              placeholder={kind === "draw" ? "提卡单号 / 代理 / 套餐" : "订单号 / 邮箱 / 卡密后四位"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void reload();
              }}
            />
            <KmSelect
              className="w-40"
              value={status}
              placeholder="全部状态"
              options={[
                { value: "", label: "全部状态" },
                ...STATUS_FILTERS.map((item) => ({ value: item, label: STATUS_LABEL[item] || item })),
              ]}
              onChange={setStatus}
            />
            {/* 隐藏、轮询、修锁只对兑换单有用，提卡单页签不显示 */}
            {kind !== "draw" ? (
              <label className="flex items-center gap-2 text-sm text-[var(--km-fg-muted)]">
                <input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} />
                显示已隐藏
              </label>
            ) : null}
            <button className="km-btn" onClick={() => void reload()}>
              筛选
            </button>
            {kind !== "draw" ? (
              <>
                <button
                  className="km-btn km-btn-ghost"
                  disabled={busy}
                  onClick={async () => {
                    await act({ action: "poll_inflight" });
                    await reload();
                  }}
                >
                  轮询进行中
                </button>
                <button
                  className="km-btn km-btn-ghost"
                  disabled={busy}
                  onClick={async () => {
                    const data = await act({ action: "reconcile_locks" });
                    if (data?.ok) toast(`已修复锁：释放 ${data.released ?? 0}，核销 ${data.used ?? 0}`);
                  }}
                >
                  修复卡住的锁
                </button>
              </>
            ) : null}
            <a className="km-btn km-btn-ghost" href={`/api/admin/orders?export=csv&${query()}`}>
              导出 CSV
            </a>
          </div>
          <div className="overflow-x-auto">
            <table className="km-table min-w-[820px]">
              <colgroup>
                <col style={{ width: "22%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "9%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "9%" }} />
                <col style={{ width: "9%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>订单</th>
                  <th>类型</th>
                  <th>买家 / 卡密</th>
                  <th>商品</th>
                  <th>支付</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const orderNo = String(o.orderNo || "");
                  const email = String(o.email || o.accountEmail || "—");
                  const code = String(o.codeMasked || o.codeLast4 || "—");
                  const plan = String(o.upstreamPlan || "—");
                  const message = o.message ? String(o.message) : "";
                  const expanded = expandedNo === orderNo;
                  const storeRow = o.rowKind === "store";
                  const drawRow = o.rowKind === "draw";
                  return (
                    <Fragment key={`${o.rowKind || "redeem"}-${o.id}`}>
                      <tr>
                        <td className="km-clip font-mono" title={orderNo}>
                          <div>{orderNo}</div>
                          {o.agentLabel ? (
                            <div className="text-xs text-[var(--km-fg-muted)]">{String(o.agentLabel)}</div>
                          ) : null}
                        </td>
                        <td>{kindLabel(o.kind)}</td>
                        <td>
                          <div className="km-clip" title={email}>
                            {email}
                          </div>
                          {code !== "—" ? (
                            <div className="km-clip font-mono text-xs text-[var(--km-fg-muted)]" title={code}>
                              {code}
                            </div>
                          ) : null}
                        </td>
                        <td className="km-clip" title={plan}>
                          <PlanLabel name={plan} planKey={String(o.planKey || "")} />
                        </td>
                        <td>
                          {drawRow ? (
                            <span className="km-badge" title="代理先提卡后结账，在「代理 › 提卡账本」里结算">
                              记账
                            </span>
                          ) : o.kind === "recharge" && o.payStatus === "manual" ? (
                            <span className="km-badge" title="买家拿卡密直接来兑换，不是在店铺下的单">
                              直接兑换
                            </span>
                          ) : (
                            <StatusBadge status={String(o.payStatus || "")} />
                          )}
                        </td>
                        <td>
                          <span title={message || undefined}>{progressLabel(o.kind, String(o.fulfillStatus || ""))}</span>
                        </td>
                        <td className="km-clip text-[var(--km-fg-muted)]" title={String(o.createdAt || "")}>
                          {formatWhen(o.createdAt)}
                        </td>
                        <td>
                          <div className="km-row-actions">
                            {!storeRow && o.kind === "recharge" && o.upstreamRequestId ? (
                              <button
                                className="km-btn km-btn-ghost"
                                disabled={busy}
                                onClick={async () => {
                                  await act({ action: "poll_order", orderNo: o.orderNo, requestId: o.upstreamRequestId });
                                  await reload();
                                }}
                              >
                                重拉
                              </button>
                            ) : null}
                            <button className="km-btn km-btn-ghost" onClick={() => setExpandedNo(expanded ? "" : orderNo)}>
                              {expanded ? "收起" : "明细"}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded ? (
                        <tr>
                          <td colSpan={8}>
                            {storeRow ? (
                              <StoreOrderDetail orderNo={orderNo} />
                            ) : drawRow ? (
                              <AdminDrawOrderDetail drawNo={orderNo} />
                            ) : (
                              <AdminOrderTimeline orderNo={orderNo} />
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!orders.length ? <p className="py-4 text-[var(--km-fg-muted)]">无匹配订单</p> : null}
          {nextCursor ? (
            <button className="km-btn km-btn-ghost mt-3" onClick={() => void loadMore()}>
              加载更多
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
