"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminStatusLabel } from "@/lib/status-labels";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";

type ChannelRule = {
  enabled: boolean;
  feeRatePpm: number;
  fixedFeeCents: number;
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
  cardplatform: {
    ok: boolean;
    message: string;
    spendableCents: number | null;
    currency: string;
    minSpendableCents?: number;
    warnSpendableCents?: number;
  };
  payment: { ok: boolean; message: string };
  jobs: { failed: number; retrying: number };
  alerts: Array<{ code: string; message: string; at: string }>;
};

const emptyRule: ChannelRule = {
  enabled: false,
  feeRatePpm: 0,
  fixedFeeCents: 0,
};

export function CommerceAdmin({ embedded = false }: { embedded?: boolean }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [payment, setPayment] = useState({
    apiBase: "",
    pid: "",
    key: "",
    signMode: "append" as "append" | "key_param",
    callbackBaseUrl: "",
    resolvedPublicBaseUrl: "",
    notifyUrl: "",
    channels: {
      alipay: { ...emptyRule },
      wxpay: { ...emptyRule },
    },
  });
  const [maxOrderQuantity, setMaxOrderQuantity] = useState("5");
  const [batchRedeemLimit, setBatchRedeemLimit] = useState("20");
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([]);
  const [health, setHealth] = useState<OpsHealth | null>(null);
  /** 卡台余额的关店线、预警线，按卡台币种填。 */
  const [minSpendable, setMinSpendable] = useState("");
  const [warnSpendable, setWarnSpendable] = useState("");

  async function load() {
    setLoaded(false);
    const [paymentRes, jobsRes, healthRes, rulesRes] = await Promise.all([
      fetch("/api/admin/payment", { cache: "no-store" }),
      fetch("/api/admin/jobs", { cache: "no-store" }),
      fetch("/api/admin/ops-health", { cache: "no-store" }),
      fetch("/api/admin?section=store_rules", { cache: "no-store" }),
    ]);
    const [paymentData, jobsData, healthData, rulesData] = await Promise.all([
      paymentRes.json(),
      jobsRes.json(),
      healthRes.json(),
      rulesRes.json(),
    ]);
    if (
      !paymentRes.ok ||
      !jobsRes.ok ||
      !healthRes.ok ||
      !rulesRes.ok
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
        callbackBaseUrl: paymentData.callbackBaseUrl || "",
        resolvedPublicBaseUrl: paymentData.publicBaseUrl || paymentData.resolvedPublicBaseUrl || "",
        notifyUrl: paymentData.notifyUrl || "",
        channels: {
          alipay: byChannel.alipay || { ...emptyRule },
          wxpay: byChannel.wxpay || { ...emptyRule },
        },
      }));
    }
    if (jobsRes.ok) setBackgroundJobs(jobsData.list || []);
    if (healthRes.ok) applyHealth(healthData.health || null);
    if (rulesRes.ok) {
      setMaxOrderQuantity(String(rulesData.maxOrderQuantity || 5));
      setBatchRedeemLimit(String(rulesData.batchRedeemLimit || 20));
    }
    setLoaded(true);
  }

  useEffect(() => {
    void load().catch((error) => {
      setMessage(error instanceof Error ? error.message : "配置加载失败");
    });
    // 只在打开页面时拉一次，之后由各个按钮自己重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function saveStoreRules() {
    const data = await submit("/api/admin", {
      action: "save_store_rules",
      maxOrderQuantity: Number(maxOrderQuantity || 0),
      batchRedeemLimit: Number(batchRedeemLimit || 0),
    });
    if (data) {
      setMaxOrderQuantity(String(data.maxOrderQuantity));
      setBatchRedeemLimit(String(data.batchRedeemLimit));
      setMessage(
        `买家一次最多可以买 ${data.maxOrderQuantity} 张，批量兑换一次最多 ${data.batchRedeemLimit} 张`,
      );
    }
  }

  function applyHealth(next: OpsHealth | null) {
    setHealth(next);
    if (!next) return;
    // 旧的检查结果里没有这两个字段，用服务端默认值（5.00 / 150.00）
    setMinSpendable(yuanTextFromCents(next.cardplatform.minSpendableCents ?? 500));
    setWarnSpendable(yuanTextFromCents(next.cardplatform.warnSpendableCents ?? 15_000));
  }

  async function updateHealth(action: "refresh" | "close_sales" | "open_sales") {
    const data = await submit("/api/admin/ops-health", { action });
    if (data?.health) {
      applyHealth(data.health);
      setMessage(data.health.salesOpen ? "店铺购买已开放" : data.health.reason || "店铺购买已关闭");
    }
  }

  async function saveThresholds() {
    const minCents = centsFromYuanText(minSpendable);
    const warnCents = centsFromYuanText(warnSpendable);
    if (minCents == null || warnCents == null || Number.isNaN(minCents) || Number.isNaN(warnCents)) {
      setMessage("关店线和预警线填金额，最多两位小数");
      return;
    }
    if (warnCents < minCents) {
      setMessage("预警线不能低于关店线");
      return;
    }
    const data = await submit("/api/admin/ops-health", {
      action: "set_thresholds",
      minSpendableCents: minCents,
      warnSpendableCents: warnCents,
    });
    if (data?.health) {
      applyHealth(data.health);
      setMessage("余额线已保存，已按新线重新检查");
    }
  }

  async function retryBackgroundJob(job: BackgroundJob) {
    const data = await submit("/api/admin/jobs", { id: job.id }, "PATCH");
    if (data) await load();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--km-fg-muted)]">
        {embedded ? null : (
          <Link href="/admin" className="km-btn km-btn-ghost">
            返回后台
          </Link>
        )}
        <span>
          店铺订单（补发、退款、手续费、开票）在
          <a href="/admin#store-orders" className="mx-1 underline">
            日常 › 订单 › 店铺订单
          </a>
          ；收益导出在「代理 › 收益统计」。
        </span>
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
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`km-badge ${health.salesOpen ? "km-badge-ok" : "km-badge-bad"}`}>
              {health.salesOpen ? "营业中" : "已停售"}
            </span>
            {health.salesOpen ? "买家现在可以下单。" : "买家现在下不了单，原因见下面。"}
          </p>
          {(() => {
            // 停售原因、卡台、支付、告警常常是同一句话，拆开去重后只列真有问题的
            const issues = [
              ...new Set(
                [
                  health.salesOpen ? "" : health.reason,
                  health.cardplatform.ok ? "" : health.cardplatform.message,
                  health.payment.ok ? "" : health.payment.message,
                  health.jobs.failed ? `后台任务失败 ${health.jobs.failed} 个` : "",
                  ...health.alerts.slice(0, 5).map((alert) => alert.message),
                ]
                  .flatMap((text) => String(text || "").split(" · "))
                  .map((text) => text.trim())
                  .filter(Boolean),
              ),
            ];
            const fine = [
              health.cardplatform.ok ? health.cardplatform.message : "",
              health.payment.ok ? health.payment.message : "",
            ].filter(Boolean);
            return (
              <>
                {issues.length ? (
                  <ul className="km-health-issues">
                    {issues.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                ) : null}
                {fine.length ? <p className="text-xs text-[var(--km-fg-muted)]">{fine.join(" · ")}</p> : null}
              </>
            );
          })()}
          <form
            className="km-health-thresholds"
            onSubmit={(event) => {
              event.preventDefault();
              void saveThresholds();
            }}
          >
            <label>
              <span>关店线</span>
              <input
                className="km-input"
                inputMode="decimal"
                value={minSpendable}
                onChange={(event) => setMinSpendable(event.target.value)}
              />
            </label>
            <label>
              <span>预警线</span>
              <input
                className="km-input"
                inputMode="decimal"
                value={warnSpendable}
                onChange={(event) => setWarnSpendable(event.target.value)}
              />
            </label>
            <span className="km-health-unit">{health.cardplatform.currency || "USD"}</span>
            <button className="km-btn km-btn-ghost" disabled={busy}>
              保存余额线
            </button>
            <p>
              卡台可用余额低于关店线，店铺自动停售；低于预警线只发提醒，店照常开。每次跨线只通知一次。
            </p>
          </form>
        </section>
      ) : null}

      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">下单规则</h2>
        <label className="block space-y-1 text-sm">
          <span>一次最多买几张</span>
          <input
            className="km-input w-40"
            inputMode="numeric"
            value={maxOrderQuantity}
            onChange={(event) => setMaxOrderQuantity(event.target.value)}
          />
          <span className="block text-xs text-[var(--km-fg-muted)]">
            买家在店铺页能选的最大数量，默认 5 张，最多 50 张。卡台库存不够时会先发出一部分，剩下的自动补发。
          </span>
        </label>
        <label className="block space-y-1 text-sm">
          <span>批量兑换一次最多几张</span>
          <input
            className="km-input w-40"
            inputMode="numeric"
            value={batchRedeemLimit}
            onChange={(event) => setBatchRedeemLimit(event.target.value)}
          />
          <span className="block text-xs text-[var(--km-fg-muted)]">
            兑换页和代理后台的批量兑换一次能收多少张，默认 20 张，最多 50 张。
            填大了就是一次点击要打卡台这么多次，卡台会更容易限流。
          </span>
        </label>
        <button
          className="km-btn km-btn-primary"
          disabled={busy || !loaded}
          onClick={saveStoreRules}
        >
          保存下单规则
        </button>
      </section>

      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">易支付商户与手续费</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          易支付会从外网访问「异步通知地址」。这里不能填 localhost，否则支付成功也不会发卡。
        </p>
        <label className="block space-y-1 text-sm">
          <span>支付回调地址</span>
          <input
            className="km-input w-full"
            placeholder={payment.resolvedPublicBaseUrl || "https://不走代理的域名"}
            value={payment.callbackBaseUrl}
            onChange={(event) =>
              setPayment((current) => ({
                ...current,
                callbackBaseUrl: event.target.value,
              }))
            }
          />
          <span className="block text-xs text-[var(--km-fg-muted)]">
            给易支付和卡台回调用，可以填一个不经 Cloudflare 的域名。留空就用「系统 › 接入卡台」里的本站公网地址。买家看到的订单、兑换链接不用这个地址。
          </span>
        </label>
        <p className="break-all font-mono text-xs text-[var(--km-fg-muted)]">
          将发给易支付的异步通知：
          {payment.callbackBaseUrl.trim()
            ? `${payment.callbackBaseUrl.trim().replace(/\/+$/, "")}/api/webhooks/epay`
            : payment.resolvedPublicBaseUrl
              ? `${payment.resolvedPublicBaseUrl.replace(/\/+$/, "")}/api/webhooks/epay`
              : payment.notifyUrl || "（还没填地址）"}
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
                    <td className="py-2 pr-3">
                      {adminStatusLabel(job.status, "job")}
                    </td>
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
          卡台地址和 API Key 在「接入卡台」。套餐价格在「代理管理」。代理的商店收益和提卡在「对账」里按代理结清，周结已停用。
        </p>
        <div className="flex flex-wrap gap-2">
          <a href="/admin#integration" className="km-btn km-btn-ghost inline-flex">去接入卡台</a>
          <a href="/admin#reconcile" className="km-btn km-btn-ghost inline-flex">去对账</a>
        </div>
      </section>
    </div>
  );
}
