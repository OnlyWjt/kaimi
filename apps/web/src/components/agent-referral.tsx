"use client";

import { useEffect, useState } from "react";
import { ReferralInviters } from "@/components/referral-inviters";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";

type PlanRow = {
  planKey: string;
  planName: string;
  retailPriceCents: number;
  costCents: number;
  maxCents: number;
  amountCents: number | null;
  overMax: boolean;
};

type Settings = {
  enabled: boolean;
  firstEnabledAt: string | null;
  couponValidDays: number;
  coolingDays: number;
  minOrderCents: number;
  monthlyCap: number;
  disabledByAdminAt: string | null;
  plans: PlanRow[];
  hint: { minInviteEarningCents: number; maxCouponCents: number };
};

type Summary = {
  invitedCount: number;
  invitedAmountCents: number;
  coolingCount: number;
  issuedCount: number;
  usedCount: number;
  expiredCount: number;
  discountCents: number;
};

type Form = {
  enabled: boolean;
  couponValidDays: string;
  coolingDays: string;
  minOrderYuan: string;
  monthlyCap: string;
  amounts: Record<string, string>;
};

function formFrom(settings: Settings): Form {
  return {
    enabled: settings.enabled,
    couponValidDays: String(settings.couponValidDays),
    coolingDays: String(settings.coolingDays),
    minOrderYuan: settings.minOrderCents ? yuanTextFromCents(settings.minOrderCents) : "0",
    monthlyCap: String(settings.monthlyCap),
    amounts: Object.fromEntries(
      settings.plans.map((plan) => [plan.planKey, plan.amountCents ? yuanTextFromCents(plan.amountCents) : ""]),
    ),
  };
}

const yuan = (cents: number) => `¥${yuanTextFromCents(cents)}`;

export function AgentReferral() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [summary, setSummary] = useState<{ month: Summary; total: Summary } | null>(null);
  const [range, setRange] = useState<"month" | "total">("month");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  async function load() {
    const [nextSettings, nextSummary] = await Promise.all([
      readApiJson<Settings>(await fetch("/api/agent/referral/settings", { cache: "no-store" })),
      readApiJson<{ month: Summary; total: Summary }>(await fetch("/api/agent/referral/summary", { cache: "no-store" })),
    ]);
    setSettings(nextSettings);
    setForm(formFrom(nextSettings));
    setSummary(nextSummary);
  }

  useEffect(() => {
    void load().catch((error) => toast(error instanceof Error ? error.message : "加载失败", "err"));
  }, []);

  async function save(enabled: boolean) {
    if (!form || !settings) return;
    const rewards = [];
    for (const plan of settings.plans) {
      const text = (form.amounts[plan.planKey] || "").trim();
      if (!text) {
        rewards.push({ planKey: plan.planKey, amountCents: null });
        continue;
      }
      const cents = centsFromYuanText(text);
      if (cents == null || cents <= 0) {
        toast(`${plan.planName}：金额填得不对`, "err");
        return;
      }
      rewards.push({ planKey: plan.planKey, amountCents: cents });
    }
    const minOrderCents = centsFromYuanText(form.minOrderYuan || "0");
    if (minOrderCents == null || minOrderCents < 0) {
      toast("好友订单最低实付填得不对", "err");
      return;
    }
    setBusy(true);
    try {
      const next = await readApiJson<Settings>(
        await fetch("/api/agent/referral/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            couponValidDays: Number(form.couponValidDays),
            coolingDays: Number(form.coolingDays),
            minOrderCents,
            monthlyCap: Number(form.monthlyCap),
            rewards,
          }),
        }),
      );
      setSettings(next);
      setForm(formFrom(next));
      toast(enabled === settings.enabled ? "已保存" : enabled ? "邀请有礼已开启" : "邀请有礼已关闭");
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  if (!settings || !form) return <p className="text-sm text-[var(--km-fg-muted)]">正在读取…</p>;

  const stats = summary ? summary[range] : null;
  const typedAmounts = settings.plans
    .map((plan) => centsFromYuanText((form.amounts[plan.planKey] || "").trim()) || 0)
    .filter((cents) => cents > 0);
  const maxTyped = typedAmounts.length ? Math.max(...typedAmounts) : 0;

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>邀请有礼</h1>
          <p>
            买家在你店里付款后会拿到专属邀请链接。好友第一次下单并过了冷静期，邀请人得到一张邀请券，下次在你店里买东西直接立减。让利从你的收益里出。
          </p>
        </div>
        <span className={`km-acp-status${settings.enabled ? "" : " mute"}`}>
          {settings.enabled ? "进行中" : "未开启"}
        </span>
      </header>

      {settings.disabledByAdminAt && !settings.enabled ? (
        <p className="km-panel text-sm text-[var(--km-danger)]">平台关闭了你的邀请有礼。需要重新开启请联系平台。</p>
      ) : null}

      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-lg font-semibold">邀请券立减（按商品）</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            邀请人下次买哪个商品，就按那个商品减。留空 = 这个商品不能用邀请券。「最多能减」是这一单你收益刚好为 0 的金额，填多了保存不了。
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="km-acp-orders">
            <thead>
              <tr>
                <th>商品</th>
                <th className="num">售价</th>
                <th className="num">你的成本</th>
                <th className="num">最多能减</th>
                <th>邀请券立减（元）</th>
              </tr>
            </thead>
            <tbody>
              {settings.plans.map((plan) => {
                const typed = centsFromYuanText((form.amounts[plan.planKey] || "").trim());
                const over = typed != null && typed > plan.maxCents;
                return (
                  <tr key={plan.planKey}>
                    <td className="product">{plan.planName}</td>
                    <td className="num">{yuan(plan.retailPriceCents)}</td>
                    <td className="num">{yuan(plan.costCents)}</td>
                    <td className="num">{yuan(plan.maxCents)}</td>
                    <td>
                      <input
                        className="km-input w-28"
                        inputMode="decimal"
                        disabled={plan.maxCents <= 0 && !form.amounts[plan.planKey]}
                        title={plan.maxCents <= 0 ? "售价扣掉成本和通道费没有利润，不能参与" : undefined}
                        placeholder={plan.maxCents <= 0 ? "没有利润" : "不参与"}
                        value={form.amounts[plan.planKey] || ""}
                        onChange={(event) =>
                          setForm({ ...form, amounts: { ...form.amounts, [plan.planKey]: event.target.value } })
                        }
                      />
                      {over ? <span className="hint text-[var(--km-danger)]">超过最多能减</span> : null}
                      {!over && plan.overMax ? (
                        <span className="hint">售价或成本变了，结账时会自动按最多能减封顶</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!settings.plans.length ? (
            <p className="py-6 text-center text-sm text-[var(--km-fg-muted)]">店里还没有在卖的商品</p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block space-y-1 text-sm">
            邀请券有效期（天）
            <input
              className="km-input w-full"
              inputMode="numeric"
              value={form.couponValidDays}
              onChange={(event) => setForm({ ...form, couponValidDays: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            冷静期（天）
            <input
              className="km-input w-full"
              inputMode="numeric"
              value={form.coolingDays}
              onChange={(event) => setForm({ ...form, coolingDays: event.target.value })}
            />
            <span className="block text-xs text-[var(--km-fg-muted)]">好友订单发货后满这么多天才发券</span>
          </label>
          <label className="block space-y-1 text-sm">
            好友订单最低实付（元）
            <input
              className="km-input w-full"
              inputMode="decimal"
              value={form.minOrderYuan}
              onChange={(event) => setForm({ ...form, minOrderYuan: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            每位邀请人每月最多得券（张）
            <input
              className="km-input w-full"
              inputMode="numeric"
              value={form.monthlyCap}
              onChange={(event) => setForm({ ...form, monthlyCap: event.target.value })}
            />
          </label>
        </div>

        {settings.plans.length ? (
          <p className="rounded-lg border border-[var(--km-border)] p-3 text-sm">
            好友首单买最便宜的商品，你也至少赚 {yuan(settings.hint.minInviteEarningCents)}；一张邀请券最多让利{" "}
            {yuan(maxTyped)}。
            {maxTyped > settings.hint.minInviteEarningCents
              ? " 让利比一单的收益还多，有人用小号自己邀请自己会亏，建议调低或调高最低实付。"
              : " 就算有人用小号自己邀请自己，你也不亏。"}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {settings.enabled ? (
            <>
              <button type="button" className="km-btn" disabled={busy} onClick={() => void save(true)}>
                保存
              </button>
              <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void save(false)}>
                关闭活动
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="km-btn"
                disabled={busy || Boolean(settings.disabledByAdminAt)}
                onClick={() => void save(true)}
              >
                保存并开启
              </button>
              <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void save(false)}>
                只保存
              </button>
            </>
          )}
        </div>
        <p className="text-xs text-[var(--km-fg-muted)]">
          关闭后不再记新的邀请、买家看不到邀请链接；冷静期里的照常发券，已发的券到期前照常能用。开启前已经发货的订单不会生成邀请码。
        </p>
      </section>

      <section className="km-panel space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">效果</h2>
          <div className="km-acp-chips">
            <button type="button" className={`km-acp-chip${range === "month" ? " is-on" : ""}`} onClick={() => setRange("month")}>
              本月
            </button>
            <button type="button" className={`km-acp-chip${range === "total" ? " is-on" : ""}`} onClick={() => setRange("total")}>
              全部
            </button>
          </div>
        </div>
        {stats ? (
          <div className="km-acp-kpis">
            <div className="km-acp-kpi">
              <span>带来新客</span>
              <strong>{stats.invitedCount}</strong>
              <small>成交 {yuan(stats.invitedAmountCents)}</small>
            </div>
            <div className="km-acp-kpi">
              <span>已发邀请券</span>
              <strong>{stats.issuedCount}</strong>
              <small>冷静期中 {stats.coolingCount}</small>
            </div>
            <div className="km-acp-kpi">
              <span>已用</span>
              <strong>{stats.usedCount}</strong>
              <small>过期未用 {stats.expiredCount}</small>
            </div>
            <div className="km-acp-kpi">
              <span>让利</span>
              <strong>{yuan(stats.discountCents)}</strong>
            </div>
          </div>
        ) : null}
      </section>

      <section className="km-panel space-y-3">
        <div>
          <h2 className="text-lg font-semibold">我的买家邀请</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">只列邀请成功过的买家。可以按邮箱、邀请码或券码搜。没用掉的券可以停用。</p>
        </div>
        <ReferralInviters
          listUrl="/api/agent/referral/inviters"
          detailUrl={(codeId) => `/api/agent/referral/inviters/${codeId}`}
          revokeUrl={(couponId) => `/api/agent/referral/coupons/${couponId}/revoke`}
          refreshKey={refreshKey}
        />
        <button type="button" className="km-acp-link" onClick={() => setRefreshKey((key) => key + 1)}>
          刷新
        </button>
      </section>
    </>
  );
}
