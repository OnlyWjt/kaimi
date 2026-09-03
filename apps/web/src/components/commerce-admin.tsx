"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { copyText } from "@/lib/copy-text";

type ChannelRule = {
  enabled: boolean;
  feeRatePpm: number;
  fixedFeeCents: number;
};

type AgentOption = { id: number; displayName: string };
type Settlement = {
  id: number;
  settlementNo: string;
  agentName: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  status: string;
  paymentReference: string;
};
type StoreOrder = {
  id: number;
  orderNo: string;
  agentName: string;
  productName: string;
  retailPriceCents: number;
  payStatus: string;
  fulfillStatus: string;
  feeReconcileStatus: string;
  lastErrorMessage: string;
};
type BackgroundJob = {
  id: number;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  updatedAt: string;
};
type OpsHealth = {
  salesOpen: boolean;
  reason: string;
  checkedAt: string;
  cardplatform: { ok: boolean; message: string; spendableCents: number | null; currency: string };
  payment: { ok: boolean; message: string };
  jobs: { failed: number; retrying: number };
  alerts: Array<{ code: string; message: string; at: string }>;
};

const emptyRule: ChannelRule = {
  enabled: false,
  feeRatePpm: 0,
  fixedFeeCents: 0,
};

const STATUS_LABEL: Record<string, string> = {
  pending: "排队中",
  processing: "处理中",
  success: "成功",
  failed: "失败",
  unknown: "未知",
  fulfilled: "已完成",
  paid: "已支付",
  unpaid: "未支付",
  pending_pay: "待支付",
  delivered: "已发货",
  paid_undelivered: "已付未发",
  issuing: "发货中",
  confirmed: "已确认",
  unsupported: "不支持",
  pending_payment: "待返佣",
  retrying: "重试中",
};

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function statusLabel(value: string) {
  return STATUS_LABEL[value] || value || "—";
}

export function CommerceAdmin({ embedded = false }: { embedded?: boolean }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [payment, setPayment] = useState({
    apiBase: "",
    pid: "",
    key: "",
    signMode: "append" as "append" | "key_param",
    publicBaseUrl: "",
    notifyUrl: "",
    channels: {
      alipay: { ...emptyRule },
      wxpay: { ...emptyRule },
    },
  });
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [storeOrders, setStoreOrders] = useState<StoreOrder[]>([]);
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([]);
  const [health, setHealth] = useState<OpsHealth | null>(null);
  const [settlementForm, setSettlementForm] = useState({
    agentId: 0,
    periodStart: localIsoDate(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    ),
    periodEnd: localIsoDate(),
  });

  async function load() {
    setLoaded(false);
    const [paymentRes, agentsRes, settlementsRes, ordersRes, jobsRes, healthRes] = await Promise.all([
      fetch("/api/admin/payment", { cache: "no-store" }),
      fetch("/api/admin/agents", { cache: "no-store" }),
      fetch("/api/admin/settlements", { cache: "no-store" }),
      fetch("/api/admin/store-orders?pageSize=100", { cache: "no-store" }),
      fetch("/api/admin/jobs", { cache: "no-store" }),
      fetch("/api/admin/ops-health", { cache: "no-store" }),
    ]);
    const [paymentData, agentData, settlementData, orderData, jobsData, healthData] = await Promise.all([
      paymentRes.json(),
      agentsRes.json(),
      settlementsRes.json(),
      ordersRes.json(),
      jobsRes.json(),
      healthRes.json(),
    ]);
    if (
      !paymentRes.ok ||
      !agentsRes.ok ||
      !settlementsRes.ok ||
      !ordersRes.ok ||
      !jobsRes.ok ||
      !healthRes.ok
    ) {
      throw new Error("配置加载失败，已禁止保存，请重试");
    }
    if (paymentRes.ok) {
      const byChannel = Object.fromEntries(
        (paymentData.channels || []).map((row: ChannelRule & { channel: string }) => [
          row.channel,
          row,
        ]),
      ) as Record<string, ChannelRule>;
      setPayment((current) => ({
        ...current,
        apiBase: paymentData.apiBase || "",
        pid: paymentData.pid || "",
        signMode: paymentData.signMode || "append",
        publicBaseUrl: paymentData.publicBaseUrl || paymentData.resolvedPublicBaseUrl || "",
        notifyUrl: paymentData.notifyUrl || "",
        channels: {
          alipay: byChannel.alipay || { ...emptyRule },
          wxpay: byChannel.wxpay || { ...emptyRule },
        },
      }));
    }
    if (agentsRes.ok) {
      const nextAgents = agentData.list || [];
      setAgents(nextAgents);
      setSettlementForm((current) => ({
        ...current,
        agentId: current.agentId || nextAgents[0]?.id || 0,
      }));
    }
    if (settlementsRes.ok) setSettlements(settlementData.list || []);
    if (ordersRes.ok) setStoreOrders(orderData.list || []);
    if (jobsRes.ok) setBackgroundJobs(jobsData.list || []);
    if (healthRes.ok) setHealth(healthData.health || null);
    setLoaded(true);
  }

  useEffect(() => {
    void load().catch((error) => {
      setMessage(error instanceof Error ? error.message : "配置加载失败");
    });
  }, []);

  async function submit(
    url: string,
    body?: unknown,
    method: "POST" | "PATCH" = "POST",
  ) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作失败");
      setMessage("保存成功");
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function savePayment() {
    const data = await submit("/api/admin/payment", payment);
    if (data) {
      setPayment((current) => ({ ...current, key: "" }));
      await load();
    }
  }

  async function recalculateFees() {
    const data = await submit("/api/admin/earnings/recalculate");
    if (!data) return;
    const notes: string[] = [];
    if (data.skippedSettled) {
      notes.push(
        `${data.skippedSettled} 笔已被结算单占用，没有改动 —— 请先在下面把对应的待返佣结算单「撤销」，再点一次重算`,
      );
    }
    if (data.skippedGatewayActual) {
      notes.push(`${data.skippedGatewayActual} 笔用网关真实手续费`);
    }
    if (data.skippedNegative) {
      notes.push(`${data.skippedNegative} 笔按新费率会亏本，请检查零售价`);
    }
    setMessage(
      `已重算 ${data.updated} 笔（扫描 ${data.scanned} 笔，${data.unchanged} 笔本来就是对的）` +
        (notes.length ? `。${notes.join("；")}` : ""),
    );
    await load();
  }

  async function createSettlement() {
    const data = await submit("/api/admin/settlements", {
      agentId: settlementForm.agentId,
      periodStart: settlementForm.periodStart,
      periodEnd: settlementForm.periodEnd,
    });
    if (data?.settlement) {
      setMessage(
        `已生成结算单 ${data.settlement.settlementNo}，金额 ¥${(data.settlement.amountCents / 100).toFixed(2)}`,
      );
      await load();
    }
  }

  async function cancelSettlement(settlement: Settlement) {
    const ok = window.confirm(
      `撤销结算单 ${settlement.settlementNo}？单据里的 ¥${(settlement.amountCents / 100).toFixed(2)} 收益会退回待结算，之后可以重算手续费再重新生成。`,
    );
    if (!ok) return;
    const data = await submit(
      `/api/admin/settlements/${settlement.id}`,
      { action: "cancel" },
      "PATCH",
    );
    if (data) {
      setMessage(`已撤销 ${settlement.settlementNo}，收益已退回待结算`);
      await load();
    }
  }

  async function markSettlementPaid(settlement: Settlement) {
    const paymentMethod = window.prompt("返佣方式（如支付宝/银行转账）");
    if (!paymentMethod) return;
    const paymentReference = window.prompt("付款流水号");
    if (!paymentReference) return;
    const data = await submit(`/api/admin/settlements/${settlement.id}`, {
      action: "mark_paid",
      paymentMethod,
      paymentReference,
    }, "PATCH");
    if (data) await load();
  }

  async function storeOrderAction(order: StoreOrder, action: "retry" | "fee" | "recovery") {
    const suffix =
      action === "retry"
        ? "retry-fulfillment"
        : action === "fee"
          ? "reconcile-fee"
          : "recovery-link";
    const data = await submit(
      `/api/admin/store-orders/${encodeURIComponent(order.orderNo)}/${suffix}`,
    );
    if (data?.recoveryUrl) {
      try {
        await copyText(data.recoveryUrl);
        setMessage(`已复制 ${order.orderNo} 的查单链接`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "复制失败，请手动复制");
      }
    } else if (data) {
      await load();
    }
  }

  async function resolveUnknown(order: StoreOrder) {
    const issued = window.confirm(
      `是否已在卡台确认订单 ${order.orderNo} 生成了卡密？\n确定=补录卡密，取消=继续选择未发码重试。`,
    );
    if (issued) {
      const code = window.prompt("请输入从卡台核对到的完整卡密");
      if (!code) return;
      const data = await submit(
        `/api/admin/store-orders/${encodeURIComponent(order.orderNo)}/resolve`,
        { action: "confirm_issued", code },
        "PATCH",
      );
      if (data) await load();
      return;
    }
    const confirmation = window.prompt("确认卡台未发码，请输入完整订单号");
    if (!confirmation) return;
    const data = await submit(
      `/api/admin/store-orders/${encodeURIComponent(order.orderNo)}/resolve`,
      { action: "confirm_not_issued", confirmation },
      "PATCH",
    );
    if (data) await load();
  }

  async function recordRefund(order: StoreOrder) {
    const type = window.confirm(
      `订单 ${order.orderNo} 是否为拒付？\n确定=拒付，取消=普通退款。`,
    )
      ? "chargeback"
      : "refund";
    const reference = window.prompt("请输入支付渠道退款/拒付参考号");
    if (!reference) return;
    const reason = window.prompt("请输入退款/拒付原因");
    if (!reason) return;
    const confirmation = window.prompt(
      "此操作会禁用未使用卡密并冲正收益，请输入完整订单号确认",
    );
    if (!confirmation) return;
    const data = await submit(
      `/api/admin/store-orders/${encodeURIComponent(order.orderNo)}/refund`,
      { type, reference, reason, confirmation },
      "PATCH",
    );
    if (data) await load();
  }

  async function updateHealth(action: "refresh" | "close_sales" | "open_sales") {
    const data = await submit("/api/admin/ops-health", { action });
    if (data?.health) {
      setHealth(data.health);
      setMessage(data.health.salesOpen ? "店铺购买已开放" : data.health.reason || "店铺购买已关闭");
    }
  }

  async function retryBackgroundJob(job: BackgroundJob) {
    const data = await submit("/api/admin/jobs", { id: job.id }, "PATCH");
    if (data) await load();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {embedded ? null : (
          <Link href="/admin" className="km-btn km-btn-ghost">
            返回后台
          </Link>
        )}
        <a href="/admin#agents" className="km-btn km-btn-ghost">
          去代理管理改默认价格
        </a>
        <a href="/api/admin/earnings/export.xlsx" className="km-btn km-btn-ghost">
          导出全部收益
        </a>
      </div>
      {message ? <div className="km-stat text-sm">{message}</div> : null}

      {health ? (
        <section className="km-panel space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">运营状态</h2>
            <div className="flex flex-wrap gap-2">
              <button className="km-btn km-btn-ghost" disabled={busy} onClick={() => updateHealth("refresh")}>
                刷新检查
              </button>
              <button
                className="km-btn km-btn-ghost"
                disabled={busy}
                onClick={() => updateHealth(health.salesOpen ? "close_sales" : "open_sales")}
              >
                {health.salesOpen ? "手动关店" : "恢复开店"}
              </button>
            </div>
          </div>
          <p className="text-sm">
            {health.salesOpen ? "店铺购买开放" : health.reason || "店铺购买已关闭"}
          </p>
          <p className="text-sm text-[var(--km-fg-muted)]">
            {health.cardplatform.message} · {health.payment.message}
            {health.jobs.failed ? ` · 失败任务 ${health.jobs.failed}` : ""}
          </p>
          {health.alerts.length ? (
            <ul className="space-y-1 text-sm text-red-600">
              {health.alerts.slice(0, 5).map((alert) => (
                <li key={`${alert.code}-${alert.at}`}>{alert.message}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">易支付商户与手续费</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          易支付会从外网访问「异步通知地址」。这里不能填 localhost，否则支付成功也不会发卡。
        </p>
        <label className="block space-y-1 text-sm">
          <span>本站公网地址</span>
          <input
            className="km-input w-full"
            placeholder="https://你的域名"
            value={payment.publicBaseUrl}
            onChange={(event) =>
              setPayment((current) => ({
                ...current,
                publicBaseUrl: event.target.value,
              }))
            }
          />
        </label>
        <p className="break-all font-mono text-xs text-[var(--km-fg-muted)]">
          将发给易支付的异步通知：
          {payment.publicBaseUrl.trim()
            ? `${payment.publicBaseUrl.trim().replace(/\/+$/, "")}/api/webhooks/epay`
            : payment.notifyUrl || "（还没填公网地址）"}
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <input
            className="km-input"
            placeholder="易支付 API 地址"
            value={payment.apiBase}
            onChange={(event) =>
              setPayment((current) => ({ ...current, apiBase: event.target.value }))
            }
          />
          <input
            className="km-input"
            placeholder="商户 PID"
            value={payment.pid}
            onChange={(event) =>
              setPayment((current) => ({ ...current, pid: event.target.value }))
            }
          />
          <input
            className="km-input"
            type="password"
            placeholder="商户密钥（留空不修改）"
            value={payment.key}
            onChange={(event) =>
              setPayment((current) => ({ ...current, key: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {(["alipay", "wxpay"] as const).map((channel) => (
            <div key={channel} className="space-y-3 rounded-xl border border-[var(--km-border)] p-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={payment.channels[channel].enabled}
                  onChange={(event) =>
                    setPayment((current) => ({
                      ...current,
                      channels: {
                        ...current.channels,
                        [channel]: {
                          ...current.channels[channel],
                          enabled: event.target.checked,
                        },
                      },
                    }))
                  }
                />
                {channel === "alipay" ? "支付宝" : "微信支付"}
              </label>
              <label className="block space-y-1 text-sm">
                <span>比例费率（PPM）</span>
                <input
                  className="km-input w-full"
                  inputMode="numeric"
                  placeholder="6000 = 0.6%"
                  value={payment.channels[channel].feeRatePpm}
                  onChange={(event) =>
                    setPayment((current) => ({
                      ...current,
                      channels: {
                        ...current.channels,
                        [channel]: {
                          ...current.channels[channel],
                          feeRatePpm: Number(event.target.value || 0),
                        },
                      },
                    }))
                  }
                />
                <span className="text-xs text-[var(--km-fg-muted)]">
                  按订单金额抽成。6000 表示 0.6%，10000 表示 1%。填 0 则不抽成。
                </span>
              </label>
              <label className="block space-y-1 text-sm">
                <span>每笔固定手续费（分）</span>
                <input
                  className="km-input w-full"
                  inputMode="numeric"
                  placeholder="10 = 0.10 元"
                  value={payment.channels[channel].fixedFeeCents}
                  onChange={(event) =>
                    setPayment((current) => ({
                      ...current,
                      channels: {
                        ...current.channels,
                        [channel]: {
                          ...current.channels[channel],
                          fixedFeeCents: Number(event.target.value || 0),
                        },
                      },
                    }))
                  }
                />
                <span className="text-xs text-[var(--km-fg-muted)]">
                  每笔额外扣的固定费，单位是分。10 表示 0.10 元，0 表示不加固定费。
                </span>
              </label>
            </div>
          ))}
        </div>
        <button className="km-btn km-btn-primary" disabled={busy || !loaded} onClick={savePayment}>
          保存支付配置
        </button>
      </section>

      {backgroundJobs.length ? (
        <section className="km-panel space-y-4">
          <h2 className="text-xl font-semibold">异常后台任务</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)]">
                  <th className="py-2 pr-3">任务</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2 pr-3">尝试</th>
                  <th className="py-2 pr-3">错误</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {backgroundJobs.map((job) => (
                  <tr key={job.id} className="border-b border-[var(--km-border)]">
                    <td className="py-2 pr-3">{job.type}</td>
                    <td className="py-2 pr-3">{statusLabel(job.status)}</td>
                    <td className="py-2 pr-3">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="max-w-md py-2 pr-3" title={job.lastError}>
                      {job.lastError || "-"}
                    </td>
                    <td className="py-2">
                      {["failed", "retrying"].includes(job.status) ? (
                        <button
                          className="km-btn km-btn-ghost"
                          disabled={busy}
                          onClick={() => retryBackgroundJob(job)}
                        >
                          立即重试
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="km-panel space-y-3">
        <h2 className="text-xl font-semibold">卡台账户</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          卡台地址和 API Key 已放到后台「接入卡台」。这里只处理价格、订单和结算。
        </p>
        <a href="/admin#integration" className="km-btn km-btn-ghost inline-flex">
          去接入卡台
        </a>
      </section>

      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">即时发卡订单</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">订单</th>
                <th className="py-2 pr-3">代理/套餐</th>
                <th className="py-2 pr-3">金额</th>
                <th className="py-2 pr-3">支付</th>
                <th className="py-2 pr-3">发卡</th>
                <th className="py-2 pr-3">手续费</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {storeOrders.map((order) => (
                <tr key={order.id} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3 font-mono">{order.orderNo}</td>
                  <td className="py-2 pr-3">
                    {order.agentName} · {order.productName}
                  </td>
                  <td className="py-2 pr-3">
                    ¥{(order.retailPriceCents / 100).toFixed(2)}
                  </td>
                  <td className="py-2 pr-3">{statusLabel(order.payStatus)}</td>
                  <td className="py-2 pr-3" title={order.lastErrorMessage}>
                    {statusLabel(order.fulfillStatus)}
                  </td>
                  <td className="py-2 pr-3">{statusLabel(order.feeReconcileStatus)}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      {order.payStatus === "paid" &&
                      ["paid_undelivered", "issuing"].includes(
                        order.fulfillStatus,
                      ) ? (
                        <button
                          className="km-btn km-btn-ghost"
                          disabled={busy}
                          onClick={() => storeOrderAction(order, "retry")}
                        >
                          {order.fulfillStatus === "issuing"
                            ? "恢复履约"
                            : "重试发卡"}
                        </button>
                      ) : null}
                      {order.fulfillStatus === "unknown" ? (
                        <button
                          className="km-btn km-btn-ghost"
                          disabled={busy}
                          onClick={() => resolveUnknown(order)}
                        >
                          人工核对
                        </button>
                      ) : null}
                      {order.payStatus === "paid" &&
                      !["confirmed", "unsupported"].includes(
                        order.feeReconcileStatus,
                      ) ? (
                        <button
                          className="km-btn km-btn-ghost"
                          disabled={busy}
                          onClick={() => storeOrderAction(order, "fee")}
                        >
                          重对手续费
                        </button>
                      ) : null}
                      <button
                        className="km-btn km-btn-ghost"
                        disabled={busy}
                        onClick={() => storeOrderAction(order, "recovery")}
                      >
                        复制查单链接
                      </button>
                      {order.payStatus === "paid" ? (
                        <button
                          className="km-btn km-btn-ghost"
                          disabled={busy}
                          onClick={() => recordRefund(order)}
                        >
                          登记退款/拒付
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">代理返佣结算</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          已支付且已发卡的订单会按当前收益进入结算。易支付查不到手续费时，用后台配置的费率估算，不再卡住结算单。
        </p>
        <div className="km-stat space-y-2 text-sm">
          <p>
            手续费在下单时就按当时的费率算好存进订单了，改费率不会追溯。改过费率就先重算一次，再生成结算单。
          </p>
          <p className="text-xs text-[var(--km-fg-muted)]">
            已经进了结算单的收益不会被重算改动。如果那张结算单还没返佣，先「撤销」它，重算完再重新生成。
          </p>
          <button
            className="km-btn km-btn-ghost"
            disabled={busy || !loaded}
            onClick={recalculateFees}
          >
            按当前费率重算未结算手续费
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <select
            className="km-input"
            value={settlementForm.agentId}
            onChange={(event) =>
              setSettlementForm((current) => ({
                ...current,
                agentId: Number(event.target.value),
              }))
            }
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName}
              </option>
            ))}
          </select>
          <input
            className="km-input"
            type="date"
            value={settlementForm.periodStart}
            onChange={(event) =>
              setSettlementForm((current) => ({
                ...current,
                periodStart: event.target.value,
              }))
            }
          />
          <input
            className="km-input"
            type="date"
            value={settlementForm.periodEnd}
            onChange={(event) =>
              setSettlementForm((current) => ({
                ...current,
                periodEnd: event.target.value,
              }))
            }
          />
          <button
            className="km-btn km-btn-primary"
            disabled={busy || !loaded || !settlementForm.agentId}
            onClick={createSettlement}
          >
            生成结算单
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">结算单</th>
                <th className="py-2 pr-3">代理</th>
                <th className="py-2 pr-3">周期</th>
                <th className="py-2 pr-3">金额</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((settlement) => (
                <tr key={settlement.id} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3">{settlement.settlementNo}</td>
                  <td className="py-2 pr-3">{settlement.agentName}</td>
                  <td className="py-2 pr-3">
                    {settlement.periodStart.slice(0, 10)} 至{" "}
                    {settlement.periodEnd.slice(0, 10)}
                  </td>
                  <td className="py-2 pr-3">
                    ¥{(settlement.amountCents / 100).toFixed(2)}
                  </td>
                  <td className="py-2 pr-3">{statusLabel(settlement.status)}</td>
                  <td className="py-2">
                    {settlement.status === "pending_payment" ? (
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="km-btn km-btn-ghost"
                          disabled={busy}
                          onClick={() => markSettlementPaid(settlement)}
                        >
                          标记已返佣
                        </button>
                        <button
                          className="km-btn km-btn-ghost"
                          disabled={busy}
                          onClick={() => cancelSettlement(settlement)}
                        >
                          撤销
                        </button>
                      </div>
                    ) : (
                      settlement.paymentReference || "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="km-panel space-y-3">
        <h2 className="text-xl font-semibold">套餐默认价格</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          平台成本和代理可售套餐已经挪到「代理管理」，在一张表里改，不再每个套餐单独保存。
        </p>
        <a href="/admin#agents" className="km-btn km-btn-ghost inline-flex">
          打开代理管理
        </a>
      </section>
    </div>
  );
}
