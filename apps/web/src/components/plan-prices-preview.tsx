"use client";

import { useMemo, useState } from "react";
import { RegionBadge } from "@/components/region-badge";

type RegionCode = "" | "US" | "CL";

type RegionRow = {
  country: RegionCode;
  label: string;
  cost: string;
  cap: string;
  enabled: boolean;
  sellable: boolean;
};

type PlanCard = {
  key: string;
  name: string;
  category: "会员" | "续费" | "点数" | "成品号";
  kind: "卡台" | "本地库存";
  regions: RegionRow[];
};

const PLANS: PlanCard[] = [
  {
    key: "go",
    name: "Go",
    category: "会员",
    kind: "卡台",
    regions: [
      { country: "", label: "菲区", cost: "0.00", cap: "", enabled: false, sellable: true },
      { country: "US", label: "美区", cost: "0.00", cap: "", enabled: false, sellable: true },
      { country: "CL", label: "智利区", cost: "0.00", cap: "", enabled: false, sellable: true },
    ],
  },
  {
    key: "plus",
    name: "Plus",
    category: "会员",
    kind: "卡台",
    regions: [
      { country: "", label: "菲区", cost: "660.00", cap: "1000.00", enabled: true, sellable: true },
      { country: "US", label: "美区", cost: "0.00", cap: "", enabled: false, sellable: true },
      { country: "CL", label: "智利区", cost: "640.00", cap: "10000.00", enabled: true, sellable: true },
    ],
  },
  {
    key: "pro5x",
    name: "Pro 5x",
    category: "会员",
    kind: "卡台",
    regions: [
      { country: "", label: "菲区", cost: "1020.00", cap: "2000.00", enabled: true, sellable: true },
      { country: "US", label: "美区", cost: "0.00", cap: "", enabled: false, sellable: true },
      { country: "CL", label: "智利区", cost: "980.00", cap: "2000.00", enabled: true, sellable: true },
    ],
  },
  {
    key: "pro",
    name: "Pro",
    category: "会员",
    kind: "卡台",
    regions: [
      { country: "", label: "菲区", cost: "1680.00", cap: "2500.00", enabled: true, sellable: true },
      { country: "US", label: "美区", cost: "0.00", cap: "", enabled: false, sellable: true },
      { country: "CL", label: "智利区", cost: "0.00", cap: "", enabled: false, sellable: true },
    ],
  },
  {
    key: "pro50",
    name: "Pro 50x",
    category: "会员",
    kind: "卡台",
    regions: [
      { country: "", label: "菲区", cost: "3070.00", cap: "5000.00", enabled: true, sellable: true },
      { country: "US", label: "美区", cost: "0.00", cap: "", enabled: false, sellable: true },
      { country: "CL", label: "智利区", cost: "0.00", cap: "", enabled: false, sellable: true },
    ],
  },
  {
    key: "pro20renew",
    name: "Pro 20x 续费",
    category: "续费",
    kind: "卡台",
    regions: [{ country: "", label: "菲区", cost: "1030.00", cap: "2000.00", enabled: false, sellable: true }],
  },
  {
    key: "c250",
    name: "Codex 点数 250",
    category: "点数",
    kind: "卡台",
    regions: [{ country: "", label: "菲区", cost: "111.00", cap: "2222.00", enabled: false, sellable: true }],
  },
  {
    key: "c500",
    name: "Codex 点数 500",
    category: "点数",
    kind: "卡台",
    regions: [{ country: "", label: "菲区", cost: "222.00", cap: "", enabled: false, sellable: true }],
  },
  {
    key: "c1000",
    name: "Codex 点数 1000",
    category: "点数",
    kind: "卡台",
    regions: [{ country: "", label: "菲区", cost: "333.00", cap: "", enabled: false, sellable: true }],
  },
  {
    key: "gpt",
    name: "GPT 成品号",
    category: "成品号",
    kind: "本地库存",
    regions: [{ country: "", label: "菲区", cost: "3.00", cap: "", enabled: true, sellable: true }],
  },
];

const CATEGORIES = ["全部", "会员", "续费", "点数", "成品号"] as const;

function regionState(row: RegionRow) {
  const priced = Number(row.cost) > 0;
  if (!priced) return { text: "待定价", tone: "text-amber-700 bg-amber-50" };
  if (row.enabled) return { text: "已启用", tone: "text-emerald-800 bg-emerald-50" };
  return { text: "未启用", tone: "text-[var(--km-fg-muted)] bg-[var(--km-bg-muted)]" };
}

export function PlanPricesPreview() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("全部");
  const [openKey, setOpenKey] = useState("plus");
  const [plans, setPlans] = useState(PLANS);

  const visible = useMemo(
    () => (category === "全部" ? plans : plans.filter((plan) => plan.category === category)),
    [category, plans],
  );
  const sections = CATEGORIES.filter((name) => name !== "全部").filter((name) =>
    visible.some((plan) => plan.category === name),
  );

  function patchRegion(planKey: string, index: number, patch: Partial<RegionRow>) {
    setPlans((current) =>
      current.map((plan) =>
        plan.key === planKey
          ? { ...plan, regions: plan.regions.map((row, i) => (i === index ? { ...row, ...patch } : row)) }
          : plan,
      ),
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <div>
        <p className="text-xs text-[var(--km-fg-muted)]">静态设计稿 · 不保存、不连数据</p>
        <h1 className="mt-1 text-2xl font-semibold">默认成本价</h1>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          先按品类看。每张套餐上直接标出各地区是已启用、未启用还是待定价，点开才改价格。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((name) => {
          const count = name === "全部" ? plans.length : plans.filter((plan) => plan.category === name).length;
          return (
            <button
              key={name}
              type="button"
              className={`km-tab ${category === name ? "km-tab-active" : ""}`}
              onClick={() => setCategory(name)}
            >
              {name} {count}
            </button>
          );
        })}
      </div>

      {sections.map((name) => (
        <section key={name} className="space-y-2">
          <h2 className="px-1 text-sm font-medium text-[var(--km-fg-muted)]">{name}</h2>
          {visible
            .filter((plan) => plan.category === name)
            .map((plan) => {
              const open = openKey === plan.key;
              const enabledCount = plan.regions.filter((row) => row.enabled && Number(row.cost) > 0).length;
              const multi = plan.regions.length > 1;
              return (
                <article key={plan.key} className="km-panel !p-0 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenKey(open ? "" : plan.key)}>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <b>{plan.name}</b>
                        <span className="font-mono text-xs text-[var(--km-fg-muted)]">{plan.key}</span>
                        <span className="text-xs text-[var(--km-fg-muted)]">
                          {plan.kind}
                          {multi ? ` · ${enabledCount}/${plan.regions.length} 已启用` : ""}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {plan.regions.map((row) => {
                          const state = regionState(row);
                          return (
                            <span key={row.country || "ph"} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs ${state.tone}`}>
                              <RegionBadge country={row.country} regionLabel={row.label} compact />
                              {state.text}
                              {Number(row.cost) > 0 ? ` ¥${row.cost}` : ""}
                            </span>
                          );
                        })}
                      </div>
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--km-fg-muted)]">{open ? "收起" : "编辑"}</span>
                      {multi ? (
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm">
                          全部启用并开放
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {open ? (
                    <div className={`grid gap-px border-t border-[var(--km-border)] bg-[var(--km-border)] ${multi ? "md:grid-cols-3" : ""}`}>
                      {plan.regions.map((row, index) => (
                        <div key={row.country || "ph"} className="space-y-3 bg-[var(--km-bg-elevated)] p-4">
                          <div className="flex items-center justify-between gap-2">
                            <RegionBadge country={row.country} regionLabel={row.label} size="md" />
                            <span className="text-xs text-[var(--km-fg-muted)]">{row.sellable ? "可售" : "不可售"}</span>
                          </div>
                          <label className="block text-xs text-[var(--km-fg-muted)]">
                            默认成本
                            <input className="km-input mt-1" value={row.cost} onChange={(event) => patchRegion(plan.key, index, { cost: event.target.value })} />
                          </label>
                          <label className="block text-xs text-[var(--km-fg-muted)]">
                            零售价上限
                            <input
                              className="km-input mt-1"
                              placeholder="不限价"
                              value={row.cap}
                              onChange={(event) => patchRegion(plan.key, index, { cap: event.target.value })}
                            />
                          </label>
                          <div className="flex items-center justify-between gap-2">
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={row.enabled}
                                disabled={Number(row.cost) <= 0}
                                onChange={(event) => patchRegion(plan.key, index, { enabled: event.target.checked })}
                              />
                              启用
                            </label>
                            {!multi ? (
                              <button type="button" className="text-xs text-[var(--km-fg-muted)] underline">
                                开放给全部代理
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
        </section>
      ))}
    </div>
  );
}
