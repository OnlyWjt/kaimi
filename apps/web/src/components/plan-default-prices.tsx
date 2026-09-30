"use client";

import { useEffect, useMemo, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";
import { messageFromApiBody } from "@/lib/http-error";
import { MAX_CATEGORY_LENGTH, normalizeCategory } from "@/lib/plan-category";
import { GRANT_PLANS_SAVE_FIRST } from "@/lib/plan-grant-core";
import { maxRetailPriceError } from "@/lib/plan-price-core";
import { groupPlansByBase, regionDisplay } from "@/lib/cardplatform/regions";
import { RegionBadge } from "@/components/region-badge";

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
  basePlanKey?: string;
  paymentCountry?: string;
  regionLabel?: string;
  regionCapable?: boolean;
  regionNote?: string;
};

const GRANT_CONFIRM =
  "会给全部活跃代理加上这个套餐。已经在卖的零售价不动，新开的用默认成本当售价。某个代理不卖仍去「代理管理」取消勾选。";

type RegionInfo = {
  accountName: string;
  protocolSupported: boolean;
  syncedAt: string | null;
  regions: { country: string; currency: string }[];
  whitelist: string[];
};

/** 卡台支持哪些付款地区，以及哪些地区自动生成变体。 */
function RegionPanel({ busy, onSynced }: { busy: string; onSynced: () => void }) {
  const [info, setInfo] = useState<RegionInfo | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function loadRegions() {
    const response = await fetch("/api/admin/cardplatform/regions", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) return;
    setInfo(data as RegionInfo);
    setChecked((data.whitelist || []) as string[]);
  }

  useEffect(() => {
    void loadRegions();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/cardplatform/regions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ whitelist: checked }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "地区设置保存失败");
      if (data.syncError) {
        toast(`地区设置已保存，但同步失败：${data.syncError}`, "err");
      } else {
        toast(`地区设置已保存${data.variantsCreated ? `，新生成 ${data.variantsCreated} 个地区版本` : ""}`);
      }
      await loadRegions();
      onSynced();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "地区设置保存失败", "err");
    } finally {
      setSaving(false);
    }
  }

  if (!info) return null;
  const syncedText = info.syncedAt
    ? new Date(info.syncedAt).toLocaleString("zh-CN", { hour12: false })
    : "还没同步过";
  return (
    <div className="rounded-lg border border-[var(--km-border)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b>卡台付款地区</b>
        <span className="text-[var(--km-fg-muted)]">上次同步 {syncedText}</span>
      </div>
      {info.protocolSupported ? (
        <>
          <p className="mt-1 text-[var(--km-fg-muted)]">
            默认卡台账户：{info.accountName}。勾选的地区会给每个非续费、非点数套餐生成一个待定价版本，默认不上架。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <RegionBadge country="" /> 默认，始终可用
            </span>
            {info.regions.map((region) => (
              <label key={region.country} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={checked.includes(region.country)}
                  onChange={(event) =>
                    setChecked((current) =>
                      event.target.checked
                        ? [...current, region.country]
                        : current.filter((item) => item !== region.country),
                    )
                  }
                />
                <RegionBadge country={region.country} />
                <span className="text-[var(--km-fg-muted)]">{region.currency}</span>
              </label>
            ))}
            {info.regions.length === 0 ? (
              <span className="text-[var(--km-fg-muted)]">卡台暂未提供付款地区（可能未升级）。</span>
            ) : null}
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={saving || Boolean(busy)}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存地区设置"}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-[var(--km-danger)]">
          默认卡台账户是 Avanfinity 协议，不支持付款地区。已有的地区版本全部自动停售。
        </p>
      )}
    </div>
  );
}

/** 即时发卡和代理管理共用：每个套餐的默认成本和零售价上限就在这张表里改。 */
export function PlanDefaultPricesPanel() {
  const { ask, dialog } = useAskDialog();
  const [catalog, setCatalog] = useState<CatalogPlan[]>([]);
  const [savedCatalog, setSavedCatalog] = useState<CatalogPlan[]>([]);
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [upstreamDraft, setUpstreamDraft] = useState<Record<string, string>>({});
  const [capDraft, setCapDraft] = useState<Record<string, string>>({});
  const [categoryDraft, setCategoryDraft] = useState<Record<string, string>>({});
  const [regionLabelDraft, setRegionLabelDraft] = useState<Record<string, string>>({});
  const [regionNoteDraft, setRegionNoteDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
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
    setSavedCatalog(next);
    setCostDraft(
      Object.fromEntries(
        next.map((item) => [item.planKey, yuanTextFromCents(item.globalCostPriceCents)]),
      ),
    );
    setUpstreamDraft(
      Object.fromEntries(
        next.map((item) => [
          item.planKey,
          item.upstreamCostCents != null ? yuanTextFromCents(item.upstreamCostCents) : "",
        ]),
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
    setRegionLabelDraft(
      Object.fromEntries(next.map((item) => [item.planKey, item.regionLabel || ""])),
    );
    setRegionNoteDraft(
      Object.fromEntries(next.map((item) => [item.planKey, item.regionNote || ""])),
    );
  }

  useEffect(() => {
    void load().catch((reason) =>
      toast(reason instanceof Error ? reason.message : "套餐加载失败", "err"),
    );
  }, []);

  function needsSaveBeforeGrant(plans: CatalogPlan[]) {
    return plans.some((plan) => {
      if (!plan.enabled) return false;
      const saved = savedCatalog.find((item) => item.planKey === plan.planKey);
      return !saved?.enabled;
    });
  }

  async function grantPlans(body: { planKey: string } | { allEnabled: true }) {
    const targets =
      "planKey" in body
        ? catalog.filter((item) => item.planKey === body.planKey)
        : catalog.filter((item) => item.enabled);
    if (needsSaveBeforeGrant(targets)) {
      toast(GRANT_PLANS_SAVE_FIRST, "err");
      return;
    }
    const answer = await ask({
      title: "planKey" in body ? "开放给全部代理" : "把已启用套餐开放给全部代理",
      message: GRANT_CONFIRM,
      confirmLabel: "开放",
      cancelLabel: "取消",
    });
    if (!answer) return;
    setBusy("planKey" in body ? `grant-${body.planKey}` : "grant-all");
    try {
      const response = await fetch("/api/admin/plans/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(messageFromApiBody(data, GRANT_PLANS_SAVE_FIRST));
      }
      toast(typeof data.message === "string" ? data.message : "已开放给代理");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "开放失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function backfillUpstream() {
    const answer = await ask({
      title: "把当前进价补到历史订单？",
      message:
        "只补还没记录进价的已支付订单，按现在的套餐进价 × 数量写入，并重算平台毛利。代理收益不变。",
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

  async function save() {
    setBusy("save");
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
        const upstreamRaw = upstreamDraft[item.planKey] ?? "";
        const upstream = centsFromYuanText(upstreamRaw);
        if (upstreamRaw.trim() && (upstream == null || Number.isNaN(upstream))) {
          throw new Error(`${item.name} 的上游进价请填金额`);
        }
        return {
          planKey: item.planKey,
          name: item.name,
          category: normalizeCategory(categoryDraft[item.planKey] ?? ""),
          regionLabel: (regionLabelDraft[item.planKey] ?? "").trim(),
          regionNote: (regionNoteDraft[item.planKey] ?? "").trim(),
          globalCostPriceCents: cents,
          upstreamCostCents: upstreamRaw.trim() ? upstream : null,
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
      if (Array.isArray(data.warnings) && data.warnings.length) {
        toast(data.warnings.join("；"), "err");
      }
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "默认价格保存失败", "err");
    } finally {
      setBusy("");
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
      <RegionPanel busy={busy} onSynced={() => void load()} />
      <p className="text-sm text-[var(--km-fg-muted)]">
        每个套餐单独设默认成本和零售价上限。上限留空表示不限价；填了之后代理改价不能超过它。
        已经高于上限的老价格照卖。美区、智利区的成本要自己填，不填不能启用。
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
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">套餐</th>
                <th className="py-2 pr-3">卡台</th>
                <th className="py-2 pr-3">店铺分类</th>
                <th className="py-2 pr-3">默认成本（元）</th>
                <th className="py-2 pr-3">上游进价（元）</th>
                <th className="py-2 pr-3">零售价上限（元）</th>
                <th className="py-2 pr-3">平台可售</th>
                <th className="py-2">开放</th>
              </tr>
            </thead>
            <tbody>
              {groupPlansByBase(
                catalog.map((plan) => ({
                  ...plan,
                  basePlanKey: plan.basePlanKey || "",
                  paymentCountry: plan.paymentCountry || "",
                  regionLabel: plan.regionLabel || "",
                  regionCapable: Boolean(plan.regionCapable),
                  sortOrder: 0,
                })),
              ).flatMap((group) => {
                const grouped = group.plans.length > 1 || group.plans.some((plan) => plan.regionCapable);
                const categoryKey = group.primary.planKey;
                const rows = [];
                if (grouped) {
                  rows.push(
                    <tr key={`group-${group.baseKey}`} className="border-b border-[var(--km-border)] bg-[var(--km-bg-muted,transparent)]">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{group.primary.name}</div>
                        <div className="font-mono text-xs text-[var(--km-fg-muted)]">{group.baseKey}</div>
                      </td>
                      <td className="py-2 pr-3 text-[var(--km-fg-muted)]">
                        {group.plans.length} 个地区
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          className="km-input w-32"
                          list="km-plan-categories"
                          maxLength={MAX_CATEGORY_LENGTH}
                          placeholder="不分类"
                          value={categoryDraft[categoryKey] ?? ""}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCategoryDraft((current) => {
                              const next = { ...current };
                              for (const plan of group.plans) next[plan.planKey] = value;
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td colSpan={5} />
                    </tr>,
                  );
                }
                for (const plan of group.plans) {
                  const unpricedVariant = Boolean(plan.paymentCountry) && plan.globalCostPriceCents <= 0;
                  rows.push(
                    <tr key={plan.planKey} className="border-b border-[var(--km-border)]">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2 font-medium">
                          {grouped ? <RegionBadge country={plan.paymentCountry} regionLabel={plan.regionLabel} /> : plan.name}
                          {unpricedVariant ? (
                            <span className="km-acp-pill warn">待定价</span>
                          ) : null}
                        </div>
                        {grouped ? (
                          <input
                            className="km-input mt-1 w-28"
                            maxLength={20}
                            placeholder={regionDisplay(plan.paymentCountry).zh}
                            value={regionLabelDraft[plan.planKey] ?? ""}
                            onChange={(event) =>
                              setRegionLabelDraft((current) => ({
                                ...current,
                                [plan.planKey]: event.target.value,
                              }))
                            }
                          />
                        ) : (
                          <div className="font-mono text-xs text-[var(--km-fg-muted)]">{plan.planKey}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {plan.cardplatformSellable || isLocalAccountPlan(plan)
                          ? isLocalAccountPlan(plan)
                            ? "本地库存"
                            : "可售"
                          : plan.paymentCountry
                            ? "卡台已停售"
                            : "不可售"}
                      </td>
                      <td className="py-2 pr-3">
                        {grouped ? (
                          <span className="text-[var(--km-fg-muted)]">
                            {normalizeCategory(categoryDraft[categoryKey] ?? "") || "不分类"}
                          </span>
                        ) : (
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
                        )}
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
                      placeholder="未配置"
                      value={upstreamDraft[plan.planKey] ?? ""}
                      onChange={(event) =>
                        setUpstreamDraft((current) => ({
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
                  <td className="py-2 pr-3">
                    <label className="flex items-center gap-2" title={unpricedVariant ? "先填默认成本" : undefined}>
                      <input
                        type="checkbox"
                        checked={plan.enabled}
                        disabled={unpricedVariant}
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
                  <td className="py-2">
                    {plan.enabled ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost km-btn-sm"
                        disabled={Boolean(busy)}
                        onClick={() => void grantPlans({ planKey: plan.planKey })}
                      >
                        {busy === `grant-${plan.planKey}` ? "开放中…" : "开放给全部代理"}
                      </button>
                    ) : null}
                  </td>
                    </tr>,
                  );
                }
                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="km-btn"
          disabled={Boolean(busy) || catalog.length === 0}
          onClick={() => void save()}
        >
          {busy === "save" ? "保存中…" : "保存价格和上限"}
        </button>
        <button
          type="button"
          className="km-btn km-btn-ghost"
          disabled={Boolean(busy)}
          onClick={() => void backfillUpstream()}
        >
          {busy === "backfill" ? "补进价中…" : "把当前进价补到历史订单"}
        </button>
        {enabledCount > 0 ? (
          <button
            type="button"
            className="km-btn km-btn-ghost"
            disabled={Boolean(busy)}
            onClick={() => void grantPlans({ allEnabled: true })}
          >
            {busy === "grant-all" ? "开放中…" : "把已启用套餐开放给全部代理"}
          </button>
        ) : null}
      </div>
        </>
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">
          改成本、上限、分类或平台可售时再展开。套餐多了也不占这一页。
        </p>
      )}
      {dialog}
    </section>
  );
}
