"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "@/components/toast";
import {
  couponFaceHint,
  couponFaceLabel,
  couponUsesLabel,
  couponUsesRatio,
  moneyYuan,
  type AgentCouponItem,
  type AgentPlanRow,
} from "@/lib/agent-console-core";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { readApiJson } from "@/lib/http-error";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";
import { retailPriceError, retailPriceRangeHint } from "@/lib/plan-price-core";

function planStatus(plan: AgentPlanRow) {
  if (!plan.enabled) return { label: "未开放", tone: "mute" as const };
  if (plan.cardplatformSellable || isLocalAccountPlan(plan)) {
    return { label: "可售", tone: "ok" as const };
  }
  return { label: "平台暂时缺货", tone: "warn" as const };
}

export function AgentSell({
  initialPlans,
  initialCoupons,
}: {
  initialPlans: AgentPlanRow[];
  initialCoupons: AgentCouponItem[];
}) {
  const [plans, setPlans] = useState(initialPlans);
  const [prices, setPrices] = useState(() =>
    Object.fromEntries(
      initialPlans.map((plan) => [plan.planKey, yuanTextFromCents(plan.retailPriceCents)]),
    ),
  );
  const [coupons, setCoupons] = useState(initialCoupons);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const sellable = useMemo(() => plans.filter((plan) => plan.enabled), [plans]);

  async function loadPlans() {
    const data = await readApiJson<{ list?: AgentPlanRow[] }>(
      await fetch("/api/agent/plans", { cache: "no-store" }),
    );
    const next = data.list || [];
    setPlans(next);
    setPrices(
      Object.fromEntries(next.map((plan) => [plan.planKey, yuanTextFromCents(plan.retailPriceCents)])),
    );
  }

  async function loadCoupons() {
    const data = await readApiJson<{ list?: AgentCouponItem[] }>(
      await fetch("/api/agent/coupons", { cache: "no-store" }),
    );
    setCoupons(data.list || []);
  }

  async function savePrices() {
    setBusy(true);
    setError("");
    try {
      for (const plan of plans) {
        if (!plan.enabled) continue;
        const cents = centsFromYuanText(prices[plan.planKey] ?? "");
        if (cents == null || Number.isNaN(cents)) {
          throw new Error(`${plan.name} 请填写零售价`);
        }
        const priceError = retailPriceError(cents, {
          costPriceCents: plan.costPriceCents,
          maxRetailPriceCents: plan.maxRetailPriceCents,
        });
        if (priceError) throw new Error(`${plan.name} ${priceError}`);
        await readApiJson(
          await fetch(`/api/agent/plans/${encodeURIComponent(plan.planKey)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ retailPriceCents: cents }),
          }),
        );
      }
      await loadPlans();
      toast("零售价已保存");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "价格保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(item: AgentCouponItem) {
    setBusy(true);
    try {
      await readApiJson(
        await fetch(`/api/agent/coupons/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !item.enabled }),
        }),
      );
      await loadCoupons();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新失败", "err");
    } finally {
      setBusy(false);
    }
  }

  function planName(planKey: string) {
    return plans.find((plan) => plan.planKey === planKey)?.name || planKey;
  }

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>今天卖多少钱</h1>
          <p>零售价是底价，优惠券是临时的卖法。两件事放一页，改完心里有数。</p>
        </div>
        <div className="km-acp-tools">
          <Link href="/agent/sell/coupon" className="km-btn km-btn-primary">
            做一张券
          </Link>
        </div>
      </header>
      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}

      <section className="km-panel">
        <div className="km-acp-section-title">
          <div>
            <h2>在售套餐</h2>
            <p>只能填在成本和上限之间。保存一次，全店生效。</p>
          </div>
          <button
            type="button"
            className="km-btn"
            disabled={busy || plans.length === 0}
            onClick={() => void savePrices()}
          >
            {busy ? "保存中…" : "保存售价"}
          </button>
        </div>
        {plans.length === 0 ? (
          <p className="text-sm text-[var(--km-fg-muted)]">
            还没有可售套餐。让管理员在「代理管理」里给你勾选套餐。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="km-acp-price">
              <thead>
                <tr>
                  <th>套餐</th>
                  <th>成本</th>
                  <th>可填</th>
                  <th>零售价</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => {
                  const status = planStatus(plan);
                  return (
                    <tr key={plan.planKey}>
                      <td>
                        <b>{plan.name}</b>
                      </td>
                      <td>{moneyYuan(plan.costPriceCents)}</td>
                      <td className="text-[var(--km-fg-muted)]">
                        {retailPriceRangeHint({
                          costPriceCents: plan.costPriceCents,
                          maxRetailPriceCents: plan.maxRetailPriceCents,
                        })}
                      </td>
                      <td>
                        <input
                          className="km-input"
                          inputMode="decimal"
                          value={prices[plan.planKey] ?? ""}
                          disabled={!plan.enabled}
                          onChange={(event) =>
                            setPrices((current) => ({
                              ...current,
                              [plan.planKey]: event.target.value,
                            }))
                          }
                        />
                      </td>
                      <td>
                        <span className={`km-acp-pill${status.tone === "ok" ? "" : ` ${status.tone}`}`}>
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="km-acp-section-title">
          <div>
            <h2>店里的券</h2>
            <p>一张票面一张券。停用的变淡，有风险的用提醒标，不把表单摊在下面。</p>
          </div>
        </div>
        {coupons.length === 0 ? (
          <div className="km-acp-empty">
            <h3>还没有券</h3>
            <p>有活动再做。空着比永远摊着一个半成品表单更干净。</p>
            <Link href="/agent/sell/coupon" className="km-btn km-btn-primary">
              做第一张券
            </Link>
          </div>
        ) : (
          <div className="km-acp-coupons">
            {coupons.map((item) => (
              <article key={item.id} className={`km-acp-coupon${item.enabled ? "" : " is-off"}`}>
                <div className="km-acp-coupon-face">
                  <div>
                    <strong>{couponFaceLabel(item)}</strong>
                    <small>{couponFaceHint(item)}</small>
                  </div>
                </div>
                <div>
                  <h3>{item.name}</h3>
                  <div className="meta">
                    券码 <b>{item.code}</b> · {couponUsesLabel(item)}
                  </div>
                  <div className="km-acp-chips">
                    {item.planKeys.map((key) => (
                      <span key={key} className="km-acp-chip is-on">
                        {planName(key)}
                      </span>
                    ))}
                    {item.warnings.length ? (
                      <span className="km-acp-pill warn">{item.warnings[0].message}</span>
                    ) : null}
                  </div>
                </div>
                <div className="grid justify-items-end gap-2">
                  {item.maxUses > 0 ? (
                    <div className="km-acp-bar" aria-hidden>
                      <i style={{ width: `${couponUsesRatio(item)}%` }} />
                    </div>
                  ) : item.enabled ? (
                    <span className="km-acp-pill mute">不限次数</span>
                  ) : (
                    <span className="km-acp-pill mute">停用</span>
                  )}
                  {item.warnings.length && item.enabled ? (
                    <span className="km-acp-pill warn">提醒，不拦</span>
                  ) : null}
                  <div className="km-acp-tools">
                    <Link href={`/agent/sell/coupon/${item.id}`} className="km-btn km-btn-ghost">
                      {item.warnings.length ? "改规则" : "编辑"}
                    </Link>
                    <button
                      type="button"
                      className="km-btn km-btn-ghost"
                      disabled={busy}
                      onClick={() => void toggleEnabled(item)}
                    >
                      {item.enabled ? "停用" : "启用"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {sellable.length === 0 && coupons.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--km-fg-muted)]">
            还没有可售套餐时不能建券。先让管理员开放套餐。
          </p>
        ) : null}
      </section>
    </>
  );
}
