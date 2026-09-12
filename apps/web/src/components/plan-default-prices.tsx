"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
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
  maxRetailPriceCents: number | null;
};

/** 即时发卡和代理管理共用：每个套餐的默认成本和零售价上限就在这张表里改。 */
export function PlanDefaultPricesPanel() {
  const [catalog, setCatalog] = useState<CatalogPlan[]>([]);
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [capDraft, setCapDraft] = useState<Record<string, string>>({});
  const [categoryDraft, setCategoryDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  // 已经用过的分类做成候选项，避免同一个分类被打成几种写法
  const knownCategories = useMemo(() => {
    const seen = new Set<string>();
    Object.values(categoryDraft).forEach((value) => {
      const name = normalizeCategory(value);
      if (name) seen.add(name);
    });
    return Array.from(seen).sort();
  }, [categoryDraft]);

  async function load() {
    const response = await fetch("/api/admin/plans", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "套餐加载失败");
    const next = (data.list || []) as CatalogPlan[];
    setCatalog(next);
    setCostDraft(
      Object.fromEntries(
        next.map((item) => [item.planKey, yuanTextFromCents(item.globalCostPriceCents)]),
      ),
    );
    setCapDraft(
      Object.fromEntries(
        next.map((item) => [
          item.planKey,
          item.maxRetailPriceCents
            ? yuanTextFromCents(item.maxRetailPriceCents)
            : "",
        ]),
      ),
    );
    setCategoryDraft(
      Object.fromEntries(next.map((item) => [item.planKey, item.category || ""])),
    );
  }

  useEffect(() => {
    void load().catch((reason) =>
      toast(reason instanceof Error ? reason.message : "套餐加载失败", "err"),
    );
  }, []);

  async function save() {
    setBusy(true);
    try {
      const plans = catalog.map((item) => {
        const cents = centsFromYuanText(costDraft[item.planKey] ?? "");
        if (cents == null || Number.isNaN(cents)) {
          throw new Error(`${item.name} 的默认成本请填金额`);
        }
        const capRaw = capDraft[item.planKey] ?? "";
        const capCents = centsFromYuanText(capRaw);
        if (capRaw.trim() && (capCents == null || Number.isNaN(capCents))) {
          throw new Error(`${item.name} 的零售价上限请填金额`);
        }
        const capError = maxRetailPriceError(capCents, cents);
        if (capError) throw new Error(`${item.name} ${capError}`);
        return {
          planKey: item.planKey,
          name: item.name,
          category: normalizeCategory(categoryDraft[item.planKey] ?? ""),
          globalCostPriceCents: cents,
          maxRetailPriceCents: capRaw.trim() ? capCents : null,
          enabled: item.enabled,
        };
      });
      const response = await fetch("/api/admin/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plans }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "默认价格保存失败");
      toast("套餐价格和上限已保存");
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "默认价格保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  const enabledCount = catalog.filter((item) => item.enabled).length;

  return (
    <section className="km-panel space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">套餐价格与上限</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            {catalog.length
              ? `${catalog.length} 个套餐${enabledCount ? ` · ${enabledCount} 个已启用` : ""}。卡台新套餐会自动同步进来。`
              : "卡台套餐会自动同步进来，也可以到「接入卡台」立刻拉一次。"}
          </p>
        </div>
        <button
          type="button"
          className="km-btn km-btn-ghost"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open ? (
        <>
      <p className="text-sm text-[var(--km-fg-muted)]">
        每个套餐单独设默认成本和零售价上限。上限留空表示不限价；填了之后代理改价不能超过它。
        已经高于上限的老价格照卖。
      </p>
      <p className="text-sm text-[var(--km-fg-muted)]">
        「店铺分类」是代理店铺前台的筛选标签，填一样的名字就归到一组。留空表示不分类，
        只在「全部」里出现；全部套餐都没分类时，前台不显示分类栏。
      </p>
      <datalist id="km-plan-categories">
        {knownCategories.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {catalog.length === 0 ? (
        <p className="text-sm text-[var(--km-fg-muted)]">
          还没有套餐。等下一轮自动同步，或到「接入卡台」立刻拉一次。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">套餐</th>
                <th className="py-2 pr-3">卡台</th>
                <th className="py-2 pr-3">店铺分类</th>
                <th className="py-2 pr-3">默认成本（元）</th>
                <th className="py-2 pr-3">零售价上限（元）</th>
                <th className="py-2">平台可售</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((plan) => (
                <tr key={plan.planKey} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{plan.name}</div>
                    <div className="font-mono text-xs text-[var(--km-fg-muted)]">
                      {plan.planKey}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    {plan.cardplatformSellable || isLocalAccountPlan(plan)
                      ? isLocalAccountPlan(plan)
                        ? "本地库存"
                        : "可售"
                      : "不可售"}
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      className="km-input w-32"
                      list="km-plan-categories"
                      maxLength={MAX_CATEGORY_LENGTH}
                      placeholder="不分类"
                      value={categoryDraft[plan.planKey] ?? ""}
                      onChange={(event) =>
                        setCategoryDraft((current) => ({
                          ...current,
                          [plan.planKey]: event.target.value,
                        }))
                      }
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      className="km-input w-28"
                      inputMode="decimal"
                      value={costDraft[plan.planKey] ?? ""}
                      onChange={(event) =>
                        setCostDraft((current) => ({
                          ...current,
                          [plan.planKey]: event.target.value,
                        }))
                      }
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      className="km-input w-28"
                      inputMode="decimal"
                      placeholder="不限价"
                      value={capDraft[plan.planKey] ?? ""}
                      onChange={(event) =>
                        setCapDraft((current) => ({
                          ...current,
                          [plan.planKey]: event.target.value,
                        }))
                      }
                    />
                  </td>
                  <td className="py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={plan.enabled}
                        onChange={(event) =>
                          setCatalog((current) =>
                            current.map((item) =>
                              item.planKey === plan.planKey
                                ? { ...item, enabled: event.target.checked }
                                : item,
                            ),
                          )
                        }
                      />
                      启用
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button
        type="button"
        className="km-btn"
        disabled={busy || catalog.length === 0}
        onClick={() => void save()}
      >
        {busy ? "保存中…" : "保存价格和上限"}
      </button>
        </>
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">
          改成本、上限、分类或平台可售时再展开。套餐多了也不占这一页。
        </p>
      )}
    </section>
  );
}
