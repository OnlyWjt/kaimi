"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";
import { maxRetailPriceError } from "@/lib/plan-price-core";

type CatalogPlan = {
  planKey: string;
  name: string;
  enabled: boolean;
  cardplatformSellable: boolean;
  globalCostPriceCents: number;
  maxRetailPriceCents: number | null;
};

/** 即时发卡和代理管理共用：每个套餐的默认成本和零售价上限就在这张表里改。 */
export function PlanDefaultPricesPanel() {
  const [catalog, setCatalog] = useState<CatalogPlan[]>([]);
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [capDraft, setCapDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

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

  return (
    <section className="km-panel space-y-4">
      <div>
        <h2 className="text-xl font-semibold">套餐价格与上限</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          每个套餐单独设默认成本和零售价上限。上限留空表示不限价；填了之后代理改价不能超过它。
          已经高于上限的老价格照卖。
        </p>
      </div>
      {catalog.length === 0 ? (
        <p className="text-sm text-[var(--km-fg-muted)]">
          还没有套餐。先到「接入卡台」同步售卖套餐。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">套餐</th>
                <th className="py-2 pr-3">卡台</th>
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
                    {plan.cardplatformSellable ? "可售" : "不可售"}
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
    </section>
  );
}
