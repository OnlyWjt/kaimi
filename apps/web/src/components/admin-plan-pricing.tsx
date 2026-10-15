"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PLAN_SHELVES,
  type PlanShelf,
  type RegionFields,
  planShelf,
  regionTone,
  sellableLabel,
  withRegion,
} from "@/components/admin-plan-helpers";
import { RegionPanel } from "@/components/admin-plan-regions";
import { useAskDialog } from "@/components/ask-dialog";
import { RegionBadge } from "@/components/region-badge";
import { toast } from "@/components/toast";
import { groupPlansByBase, regionDisplay } from "@/lib/cardplatform/regions";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";
import { MAX_CATEGORY_LENGTH, normalizeCategory } from "@/lib/plan-category";
import { maxRetailPriceError } from "@/lib/plan-price-core";

type CatalogPlan = {
  planKey: string;
  name: string;
  enabled: boolean;
  cardplatformSellable: boolean;
  fulfillmentKind?: string;
  category: string;
  globalCostPriceCents: number;
  upstreamCostCents: number | null;
  maxRetailPriceCents: number | null;
} & RegionFields;

type Drafts = {
  cost: Record<string, string>;
  cap: Record<string, string>;
  upstream: Record<string, string>;
  regionLabel: Record<string, string>;
  regionNote: Record<string, string>;
};

function draftsFrom(catalog: CatalogPlan[]): Drafts {
  const by = (pick: (plan: CatalogPlan) => string) =>
    Object.fromEntries(catalog.map((plan) => [plan.planKey, pick(plan)]));
  return {
    cost: by((plan) => yuanTextFromCents(plan.globalCostPriceCents)),
    cap: by((plan) => (plan.maxRetailPriceCents ? yuanTextFromCents(plan.maxRetailPriceCents) : "")),
    upstream: by((plan) => (plan.upstreamCostCents != null ? yuanTextFromCents(plan.upstreamCostCents) : "")),
    regionLabel: by((plan) => plan.regionLabel || ""),
    regionNote: by((plan) => plan.regionNote || ""),
  };
}

/**
 * 「卖卡 › 套餐定价」：平台给代理的默认成本、零售价上限、上游进价、店铺分类、地区说明，
 * 以及卡台付款地区。代理各自的成本覆盖仍在「代理管理」里按代理改。
 */
export function AdminPlanPricing() {
  const { ask, dialog } = useAskDialog();
  const [catalog, setCatalog] = useState<CatalogPlan[]>([]);
  const [drafts, setDrafts] = useState<Drafts>(draftsFrom([]));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [shelf, setShelf] = useState<PlanShelf>("全部");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  async function load() {
    const response = await fetch("/api/admin/plans", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.error || "套餐加载失败", "err");
      return;
    }
    const next = (data.list || []) as CatalogPlan[];
    setCatalog(next);
    setDrafts(draftsFrom(next));
    setLoaded(true);
  }

  useEffect(() => {
    void load();
  }, []);

  // 已经用过的分类做成候选项，避免同一个分类被打成几种写法
  const knownCategories = useMemo(
    () => [...new Set(catalog.map((plan) => normalizeCategory(plan.category)).filter(Boolean))],
    [catalog],
  );

  const groups = useMemo(
    () =>
      groupPlansByBase(withRegion(catalog)).map((group) => ({
        ...group,
        shelf: planShelf(group.primary),
        multi: group.plans.length > 1 || group.plans.some((plan) => plan.regionCapable),
      })),
    [catalog],
  );
  const shown = shelf === "全部" ? groups : groups.filter((group) => group.shelf === shelf);
  const sections = PLAN_SHELVES.filter((name) => name !== "全部").filter((name) =>
    shown.some((group) => group.shelf === name),
  );

  function setDraft(field: keyof Drafts, planKey: string, value: string) {
    setDrafts((current) => ({ ...current, [field]: { ...current[field], [planKey]: value } }));
  }

  function patchPlans(planKeys: string[], patch: Partial<CatalogPlan>) {
    setCatalog((current) => current.map((plan) => (planKeys.includes(plan.planKey) ? { ...plan, ...patch } : plan)));
  }

  /** 一组地区版本共用主套餐的名称和分类。 */
  function payload(source: CatalogPlan[]) {
    const shared = new Map<string, { name: string; category: string }>();
    for (const group of groupPlansByBase(withRegion(source))) {
      const name = group.primary.name.trim();
      const category = normalizeCategory(group.primary.category);
      for (const plan of group.plans) shared.set(plan.planKey, { name, category });
    }
    return source.map((plan) => {
      const { name, category } = shared.get(plan.planKey) ?? { name: plan.name.trim(), category: plan.category };
      if (!name) throw new Error(`${plan.planKey} 的显示名称不能为空`);
      const cost = centsFromYuanText(drafts.cost[plan.planKey] ?? "");
      if (cost == null || Number.isNaN(cost)) throw new Error(`${name} 的默认成本请填金额`);
      const capRaw = drafts.cap[plan.planKey] ?? "";
      const cap = centsFromYuanText(capRaw);
      if (capRaw.trim() && (cap == null || Number.isNaN(cap))) throw new Error(`${name} 的零售价上限请填金额`);
      const capError = maxRetailPriceError(cap, cost);
      if (capError) throw new Error(`${name} ${capError}`);
      const upstreamRaw = drafts.upstream[plan.planKey] ?? "";
      const upstream = centsFromYuanText(upstreamRaw);
      if (upstreamRaw.trim() && (upstream == null || Number.isNaN(upstream))) {
        throw new Error(`${name} 的上游进价请填金额`);
      }
      return {
        planKey: plan.planKey,
        name,
        category,
        ...(plan.paymentCountry
          ? {
              regionLabel: (drafts.regionLabel[plan.planKey] ?? "").trim(),
              regionNote: (drafts.regionNote[plan.planKey] ?? "").trim(),
            }
          : {}),
        globalCostPriceCents: cost,
        upstreamCostCents: upstreamRaw.trim() ? upstream : null,
        maxRetailPriceCents: capRaw.trim() ? cap : null,
        enabled: plan.enabled,
      };
    });
  }

  async function putPlans(source: CatalogPlan[]) {
    const response = await fetch("/api/admin/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plans: payload(source) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "保存失败");
    if (Array.isArray(data.warnings) && data.warnings.length) toast(data.warnings.join("；"), "err");
  }

  async function save() {
    setBusy("save");
    try {
      await putPlans(catalog);
      toast("套餐定价已保存");
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function grant(plans: CatalogPlan[]) {
    const ready: CatalogPlan[] = [];
    const skipped: string[] = [];
    for (const plan of plans) {
      const cents = centsFromYuanText(drafts.cost[plan.planKey] ?? "");
      const label = plan.paymentCountry
        ? `${plan.name} · ${regionDisplay(plan.paymentCountry, plan.regionLabel).zh}`
        : plan.name;
      if (cents == null || Number.isNaN(cents) || (plan.paymentCountry && cents <= 0)) skipped.push(label);
      else ready.push(plan);
    }
    if (!ready.length) {
      toast("先填好默认成本。成本为 0 的地区不能启用。", "err");
      return;
    }
    const names = ready
      .map((plan) => (plan.paymentCountry ? regionDisplay(plan.paymentCountry, plan.regionLabel).zh : plan.name))
      .join("、");
    const answer = await ask({
      title: "开放给全部代理",
      message: `启用 ${names}，并让所有在营代理都能卖。已经在卖的零售价不动，新开的用默认成本当售价。${
        skipped.length ? `未定价的地区会跳过：${skipped.join("、")}。` : ""
      }`,
      confirmLabel: "启用并开放",
      cancelLabel: "取消",
    });
    if (!answer) return;
    setBusy("grant");
    try {
      const keys = new Set(ready.map((plan) => plan.planKey));
      const next = catalog.map((plan) => (keys.has(plan.planKey) ? { ...plan, enabled: true } : plan));
      setCatalog(next);
      await putPlans(next);
      const response = await fetch("/api/admin/plans/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKeys: [...keys] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "开放失败");
      toast(typeof data.message === "string" ? data.message : "已开放给全部代理");
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "开放失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function backfillUpstream() {
    const answer = await ask({
      title: "把当前进价补到历史订单？",
      message: "只补还没记录进价的已支付订单，按现在的套餐进价 × 数量写入，并重算平台毛利。代理收益不变。",
      confirmLabel: "补上",
      cancelLabel: "取消",
    });
    if (!answer) return;
    setBusy("backfill");
    try {
      const response = await fetch("/api/admin/plans/backfill-upstream", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "补进价失败");
      toast(`已补 ${data.updated ?? 0} 笔订单的上游进价`);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "补进价失败", "err");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      {dialog}
      <section className="km-panel space-y-2">
        <h2 className="text-xl font-semibold">套餐定价</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          默认成本是平台给代理的进货价，代理只能在自己的成本之上定零售价；某个代理单独的成本在「代理管理」里改。
          零售价上限留空表示不限价，已经高于上限的老价格照卖。上游进价用来算平台毛利，不影响代理。
        </p>
        <p className="text-sm text-[var(--km-fg-muted)]">
          「店铺分类」是代理店铺前台的筛选标签，填一样的名字就归到一组；全部套餐都没分类时，前台不显示分类栏。
        </p>
        <RegionPanel busy={busy} onSynced={() => void load()} />
      </section>

      <datalist id="km-plan-categories">
        {knownCategories.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      {loaded && !catalog.length ? (
        <p className="km-panel text-sm text-[var(--km-fg-muted)]">还没有套餐。等自动同步，或到「接入卡台」立刻拉一次。</p>
      ) : null}

      {catalog.length ? (
        <section className="km-panel space-y-4">
          <div className="km-tabs">
            {PLAN_SHELVES.map((name) => {
              const count = name === "全部" ? groups.length : groups.filter((group) => group.shelf === name).length;
              if (name !== "全部" && count === 0) return null;
              return (
                <button
                  key={name}
                  type="button"
                  className={`km-tab ${shelf === name ? "km-tab-active" : ""}`}
                  onClick={() => setShelf(name)}
                >
                  {name} {count}
                </button>
              );
            })}
          </div>
          {sections.map((name) => (
            <section key={name} className="space-y-2">
              <h3 className="px-1 text-sm font-medium text-[var(--km-fg-muted)]">{name}</h3>
              {shown
                .filter((group) => group.shelf === name)
                .map((group) => {
                  const open = Boolean(openGroups[group.baseKey]);
                  const planKeys = group.plans.map((plan) => plan.planKey);
                  const enabledCount = group.plans.filter((plan) => {
                    const cents = centsFromYuanText(drafts.cost[plan.planKey] ?? "");
                    return plan.enabled && cents != null && cents > 0;
                  }).length;
                  return (
                    <article key={group.baseKey} className="overflow-hidden rounded-2xl border border-[var(--km-border)]">
                      <div className="flex flex-wrap items-end gap-3 px-4 py-3">
                        <label className="min-w-[12rem] flex-1 text-xs text-[var(--km-fg-muted)]">
                          显示名称
                          <input
                            className="km-input mt-1"
                            maxLength={100}
                            value={group.primary.name}
                            onChange={(event) => patchPlans(planKeys, { name: event.target.value })}
                          />
                        </label>
                        <label className="w-full text-xs text-[var(--km-fg-muted)] sm:w-40">
                          店铺分类
                          <input
                            className="km-input mt-1"
                            list="km-plan-categories"
                            maxLength={MAX_CATEGORY_LENGTH}
                            placeholder="不分类"
                            value={group.primary.category}
                            onChange={(event) => patchPlans(planKeys, { category: event.target.value })}
                          />
                        </label>
                        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setOpenGroups((current) => ({ ...current, [group.baseKey]: !open }))}
                        >
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="font-mono text-xs text-[var(--km-fg-muted)]">{group.baseKey}</span>
                            <span className="text-xs text-[var(--km-fg-muted)]">
                              {sellableLabel(group.primary)}
                              {group.multi ? ` · ${enabledCount}/${group.plans.length} 已启用` : ""}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {group.plans.map((plan) => {
                              const state = regionTone(drafts.cost[plan.planKey] ?? "", plan.enabled);
                              const cents = centsFromYuanText(drafts.cost[plan.planKey] ?? "");
                              return (
                                <span
                                  key={plan.planKey}
                                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs ${state.tone}`}
                                >
                                  <RegionBadge country={plan.paymentCountry || ""} regionLabel={plan.regionLabel} compact />
                                  {state.text}
                                  {cents != null && cents > 0 ? ` ¥${drafts.cost[plan.planKey]}` : ""}
                                </span>
                              );
                            })}
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            className="km-btn km-btn-ghost km-btn-sm"
                            aria-expanded={open}
                            onClick={() => setOpenGroups((current) => ({ ...current, [group.baseKey]: !open }))}
                          >
                            {open ? "收起" : "改价格"}
                          </button>
                          {group.multi ? (
                            <button
                              type="button"
                              className="km-btn km-btn-ghost km-btn-sm"
                              disabled={Boolean(busy)}
                              onClick={() => void grant(group.plans)}
                            >
                              全部启用并开放
                            </button>
                          ) : null}
                        </div>
                        </div>
                      </div>
                      {open ? (
                        <div
                          className={`grid gap-px border-t border-[var(--km-border)] bg-[var(--km-border)] ${group.multi ? "md:grid-cols-3" : ""}`}
                        >
                          {group.plans.map((plan) => {
                            const cents = centsFromYuanText(drafts.cost[plan.planKey] ?? "");
                            const unpriced = Boolean(plan.paymentCountry) && (cents == null || cents <= 0);
                            return (
                              <div key={plan.planKey} className="space-y-3 bg-[var(--km-bg-elevated)] p-4">
                                <div className="flex items-center justify-between gap-2">
                                  <RegionBadge country={plan.paymentCountry || ""} regionLabel={plan.regionLabel} size="md" />
                                  <span className="text-xs text-[var(--km-fg-muted)]">{sellableLabel(plan)}</span>
                                </div>
                                <div className={group.multi ? "space-y-3" : "grid gap-3 sm:grid-cols-3"}>
                                  <label className="block text-xs text-[var(--km-fg-muted)]">
                                    默认成本
                                    <input
                                      className="km-input mt-1"
                                      inputMode="decimal"
                                      value={drafts.cost[plan.planKey] ?? ""}
                                      onChange={(event) => setDraft("cost", plan.planKey, event.target.value)}
                                    />
                                  </label>
                                  <label className="block text-xs text-[var(--km-fg-muted)]">
                                    零售价上限
                                    <input
                                      className="km-input mt-1"
                                      inputMode="decimal"
                                      placeholder="不限价"
                                      value={drafts.cap[plan.planKey] ?? ""}
                                      onChange={(event) => setDraft("cap", plan.planKey, event.target.value)}
                                    />
                                  </label>
                                  <label className="block text-xs text-[var(--km-fg-muted)]">
                                    上游进价
                                    <input
                                      className="km-input mt-1"
                                      inputMode="decimal"
                                      placeholder="没填不算毛利"
                                      value={drafts.upstream[plan.planKey] ?? ""}
                                      onChange={(event) => setDraft("upstream", plan.planKey, event.target.value)}
                                    />
                                  </label>
                                </div>
                                {plan.paymentCountry ? (
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="block text-xs text-[var(--km-fg-muted)]">
                                      地区名称
                                      <input
                                        className="km-input mt-1"
                                        maxLength={20}
                                        placeholder={regionDisplay(plan.paymentCountry, "").zh}
                                        value={drafts.regionLabel[plan.planKey] ?? ""}
                                        onChange={(event) => setDraft("regionLabel", plan.planKey, event.target.value)}
                                      />
                                    </label>
                                    <label className="block text-xs text-[var(--km-fg-muted)]">
                                      地区说明
                                      <input
                                        className="km-input mt-1"
                                        maxLength={40}
                                        placeholder="买家选地区时看到"
                                        value={drafts.regionNote[plan.planKey] ?? ""}
                                        onChange={(event) => setDraft("regionNote", plan.planKey, event.target.value)}
                                      />
                                    </label>
                                  </div>
                                ) : null}
                                <div className="flex items-center justify-between gap-2">
                                  <label className="flex items-center gap-2 text-sm" title={unpriced ? "先填默认成本" : undefined}>
                                    <input
                                      type="checkbox"
                                      checked={plan.enabled}
                                      disabled={unpriced}
                                      onChange={(event) => patchPlans([plan.planKey], { enabled: event.target.checked })}
                                    />
                                    启用
                                  </label>
                                  {group.multi ? null : (
                                    <button
                                      type="button"
                                      className="text-xs text-[var(--km-fg-muted)] underline disabled:opacity-50"
                                      disabled={Boolean(busy)}
                                      onClick={() => void grant([plan])}
                                    >
                                      开放给全部代理
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
            </section>
          ))}
          <div className="flex flex-wrap gap-2 border-t border-[var(--km-border)] pt-4">
            <button type="button" className="km-btn" disabled={Boolean(busy)} onClick={() => void save()}>
              {busy === "save" ? "保存中…" : "保存套餐定价"}
            </button>
            <button
              type="button"
              className="km-btn km-btn-ghost"
              disabled={Boolean(busy) || catalog.every((plan) => !plan.enabled)}
              onClick={() => void grant(catalog.filter((plan) => plan.enabled))}
            >
              {busy === "grant" ? "开放中…" : "把已启用的套餐开放给全部代理"}
            </button>
            <button
              type="button"
              className="km-btn km-btn-ghost"
              disabled={Boolean(busy)}
              onClick={() => void backfillUpstream()}
            >
              {busy === "backfill" ? "补进价中…" : "把进价补到历史订单"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
