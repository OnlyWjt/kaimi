"use client";

import { useEffect, useMemo, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { buildAgentWelcomeText } from "@/lib/agent-welcome-core";
import { copyText } from "@/lib/copy-text";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";
import {
  isOverMaxRetailPrice,
  maxRetailPriceError,
} from "@/lib/plan-price-core";
import { groupPlansByBase, regionDisplay } from "@/lib/cardplatform/regions";
import { RegionBadge } from "@/components/region-badge";

type RegionFields = {
  basePlanKey?: string;
  paymentCountry?: string;
  regionLabel?: string;
  regionCapable?: boolean;
  sortOrder?: number;
};

type AgentRow = {
  id: number;
  username: string;
  displayName: string;
  shopName?: string;
  realName?: string;
  status: "active" | "disabled";
  currentSlug: string;
  lastLoginAt: string | null;
  allowedPlans: Array<{ planKey: string; name: string } & RegionFields>;
};

type CatalogPlan = {
  planKey: string;
  name: string;
  enabled: boolean;
  cardplatformSellable: boolean;
  fulfillmentKind?: string;
  globalCostPriceCents: number;
  maxRetailPriceCents: number | null;
} & RegionFields;

type AgentPlanRow = {
  planKey: string;
  name: string;
  globalCostPriceCents: number;
  maxRetailPriceCents: number | null;
  cardplatformSellable: boolean;
  platformEnabled: boolean;
  enabled: boolean;
  costOverrideCents: number | null;
  retailPriceCents: number;
} & RegionFields;

const PLAN_SHELVES = ["全部", "会员", "续费", "点数", "成品号"] as const;

function planShelf(plan: { name: string; planKey: string; fulfillmentKind?: string }): Exclude<(typeof PLAN_SHELVES)[number], "全部"> {
  if (isLocalAccountPlan(plan) || /成品/.test(plan.name)) return "成品号";
  if (/续费|renew/i.test(`${plan.name} ${plan.planKey}`)) return "续费";
  if (/点数|credit/i.test(`${plan.name} ${plan.planKey}`)) return "点数";
  return "会员";
}

function withRegion<T extends { planKey: string; name: string } & RegionFields>(plans: T[]) {
  return plans.map((plan) => ({
    ...plan,
    basePlanKey: plan.basePlanKey || "",
    paymentCountry: plan.paymentCountry || "",
    regionLabel: plan.regionLabel || "",
    regionCapable: Boolean(plan.regionCapable),
    sortOrder: plan.sortOrder ?? 0,
  }));
}

function allowedPlanLabels(plans: AgentRow["allowedPlans"]) {
  return groupPlansByBase(withRegion(plans)).map((group) => {
    if (!group.plans.some((plan) => plan.regionCapable)) return group.primary.name;
    const regions = group.plans.map(
      (plan) => regionDisplay(plan.paymentCountry, plan.regionLabel).zh,
    );
    return `${group.primary.name}（${regions.join("/")}）`;
  });
}

function regionTone(cost: string, enabled: boolean) {
  const cents = centsFromYuanText(cost);
  const priced = cents != null && cents > 0;
  if (!priced) return { text: "待定价", tone: "text-amber-700 bg-amber-50" };
  if (enabled) return { text: "已启用", tone: "text-emerald-800 bg-emerald-50" };
  return { text: "未启用", tone: "text-[var(--km-fg-muted)] bg-[var(--km-bg-muted)]" };
}

function sellableLabel(plan: CatalogPlan) {
  if (isLocalAccountPlan(plan)) return "本地库存";
  if (plan.cardplatformSellable) return "可售";
  return plan.paymentCountry ? "卡台已停售" : "不可售";
}

function PlanCostCards({
  catalog,
  costDraft,
  capDraft,
  shelf,
  openGroups,
  busy,
  onShelf,
  onToggleGroup,
  onCost,
  onCap,
  onEnabled,
  onGrant,
}: {
  catalog: CatalogPlan[];
  costDraft: Record<string, string>;
  capDraft: Record<string, string>;
  shelf: (typeof PLAN_SHELVES)[number];
  openGroups: Record<string, boolean>;
  busy: string;
  onShelf: (shelf: (typeof PLAN_SHELVES)[number]) => void;
  onToggleGroup: (baseKey: string) => void;
  onCost: (planKey: string, value: string) => void;
  onCap: (planKey: string, value: string) => void;
  onEnabled: (planKey: string, enabled: boolean) => void;
  onGrant: (plans: CatalogPlan[]) => void;
}) {
  const groups = groupPlansByBase(withRegion(catalog)).map((group) => ({
    ...group,
    shelf: planShelf(group.primary),
    multi: group.plans.length > 1 || group.plans.some((plan) => plan.regionCapable),
  }));
  const shown = shelf === "全部" ? groups : groups.filter((group) => group.shelf === shelf);
  const sections = PLAN_SHELVES.filter((name) => name !== "全部").filter((name) =>
    shown.some((group) => group.shelf === name),
  );

  return (
    <div className="space-y-4">
      <div className="km-tabs">
        {PLAN_SHELVES.map((name) => {
          const count = name === "全部" ? groups.length : groups.filter((group) => group.shelf === name).length;
          if (name !== "全部" && count === 0) return null;
          return (
            <button
              key={name}
              type="button"
              className={`km-tab ${shelf === name ? "km-tab-active" : ""}`}
              onClick={() => onShelf(name)}
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
              const enabledCount = group.plans.filter((plan) => {
                const cents = centsFromYuanText(costDraft[plan.planKey] ?? "");
                return plan.enabled && cents != null && cents > 0;
              }).length;
              return (
                <article key={group.baseKey} className="overflow-hidden rounded-2xl border border-[var(--km-border)]">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onToggleGroup(group.baseKey)}>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <b>{group.primary.name}</b>
                        <span className="font-mono text-xs text-[var(--km-fg-muted)]">{group.baseKey}</span>
                        <span className="text-xs text-[var(--km-fg-muted)]">
                          {sellableLabel(group.primary)}
                          {group.multi ? ` · ${enabledCount}/${group.plans.length} 已启用` : ""}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {group.plans.map((plan) => {
                          const state = regionTone(costDraft[plan.planKey] ?? "", plan.enabled);
                          const cents = centsFromYuanText(costDraft[plan.planKey] ?? "");
                          return (
                            <span
                              key={plan.planKey}
                              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs ${state.tone}`}
                            >
                              <RegionBadge country={plan.paymentCountry || ""} regionLabel={plan.regionLabel} compact />
                              {state.text}
                              {cents != null && cents > 0 ? ` ¥${costDraft[plan.planKey]}` : ""}
                            </span>
                          );
                        })}
                      </div>
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--km-fg-muted)]">{open ? "收起" : "编辑"}</span>
                      {group.multi ? (
                        <button
                          type="button"
                          className="km-btn km-btn-ghost km-btn-sm"
                          disabled={Boolean(busy)}
                          onClick={() => onGrant(group.plans)}
                        >
                          全部启用并开放
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {open ? (
                    <div className={`grid gap-px border-t border-[var(--km-border)] bg-[var(--km-border)] ${group.multi ? "md:grid-cols-3" : ""}`}>
                      {group.plans.map((plan) => {
                        const cents = centsFromYuanText(costDraft[plan.planKey] ?? "");
                        const unpriced = Boolean(plan.paymentCountry) && (cents == null || cents <= 0);
                        return (
                          <div key={plan.planKey} className="space-y-3 bg-[var(--km-bg-elevated)] p-4">
                            <div className="flex items-center justify-between gap-2">
                              <RegionBadge country={plan.paymentCountry || ""} regionLabel={plan.regionLabel} size="md" />
                              <span className="text-xs text-[var(--km-fg-muted)]">{sellableLabel(plan)}</span>
                            </div>
                            <label className="block text-xs text-[var(--km-fg-muted)]">
                              默认成本
                              <input
                                className="km-input mt-1"
                                inputMode="decimal"
                                value={costDraft[plan.planKey] ?? ""}
                                onChange={(event) => onCost(plan.planKey, event.target.value)}
                              />
                            </label>
                            <label className="block text-xs text-[var(--km-fg-muted)]">
                              零售价上限
                              <input
                                className="km-input mt-1"
                                inputMode="decimal"
                                placeholder="不限价"
                                value={capDraft[plan.planKey] ?? ""}
                                onChange={(event) => onCap(plan.planKey, event.target.value)}
                              />
                            </label>
                            <div className="flex items-center justify-between gap-2">
                              <label className="flex items-center gap-2 text-sm" title={unpriced ? "先填默认成本" : undefined}>
                                <input
                                  type="checkbox"
                                  checked={plan.enabled}
                                  disabled={unpriced}
                                  onChange={(event) => onEnabled(plan.planKey, event.target.checked)}
                                />
                                启用
                              </label>
                              {group.multi ? null : (
                                <button
                                  type="button"
                                  className="text-xs text-[var(--km-fg-muted)] underline disabled:opacity-50"
                                  disabled={Boolean(busy)}
                                  onClick={() => onGrant([plan])}
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
    </div>
  );
}

export function AdminAgents() {
  const { ask, dialog } = useAskDialog();
  const [list, setList] = useState<AgentRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogPlan[]>([]);
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [capDraft, setCapDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  const [agentPlans, setAgentPlans] = useState<AgentPlanRow[]>([]);
  const [overrideDraft, setOverrideDraft] = useState<Record<string, string>>({});
  const [plansLoading, setPlansLoading] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [shelf, setShelf] = useState<(typeof PLAN_SHELVES)[number]>("全部");
  const [openAgentGroups, setOpenAgentGroups] = useState<Record<string, boolean>>({});
  const [redeemUrl, setRedeemUrl] = useState("");
  const [form, setForm] = useState({
    username: "",
    password: "",
    displayName: "",
    slug: "",
    planKeys: [] as string[],
  });

  const loginUrl =
    typeof window !== "undefined" ? `${window.location.origin}/login` : "/login";
  const startUrl =
    typeof window !== "undefined" ? `${window.location.origin}/start` : "/start";

  function welcomeText(input: { username: string; displayName?: string; password?: string }) {
    return buildAgentWelcomeText({
      loginUrl,
      startUrl,
      username: input.username,
      displayName: input.displayName,
      password: input.password,
    });
  }

  async function copyWelcome(input: {
    username: string;
    displayName?: string;
    password?: string;
    ok: string;
  }) {
    try {
      await copyText(welcomeText(input));
      toast(input.ok);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "复制失败", "err");
    }
  }

  const enabledCatalog = useMemo(
    () =>
      catalog.filter(
        (item) =>
          item.cardplatformSellable ||
          item.enabled ||
          isLocalAccountPlan(item),
      ),
    [catalog],
  );

  async function load() {
    setLoading(true);
    try {
      const [agentsRes, plansRes, portalRes] = await Promise.all([
        fetch("/api/admin/agents", { cache: "no-store" }),
        fetch("/api/admin/plans", { cache: "no-store" }),
        fetch("/api/admin?section=agent_portal", { cache: "no-store" }),
      ]);
      const [agentsData, plansData, portalData] = await Promise.all([
        agentsRes.json(),
        plansRes.json(),
        portalRes.json(),
      ]);
      if (!agentsRes.ok) throw new Error(agentsData.error || "代理列表加载失败");
      if (!plansRes.ok) throw new Error(plansData.error || "套餐加载失败");
      const nextCatalog = (plansData.list || []) as CatalogPlan[];
      setList(agentsData.list || []);
      setCatalog(nextCatalog);
      setRedeemUrl(String(portalData.redeemUrl || ""));
      setCostDraft(
        Object.fromEntries(
          nextCatalog.map((item) => [
            item.planKey,
            yuanTextFromCents(item.globalCostPriceCents),
          ]),
        ),
      );
      setCapDraft(
        Object.fromEntries(
          nextCatalog.map((item) => [
            item.planKey,
            item.maxRetailPriceCents
              ? yuanTextFromCents(item.maxRetailPriceCents)
              : "",
          ]),
        ),
      );
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "加载失败", "err");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!selectedAgent && !createOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (selectedAgent) closePlans();
      else setCreateOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedAgent, createOpen]);

  async function createAgent() {
    setBusy("create");
    try {
      const response = await fetch("/api/admin/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          slug: form.slug.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "代理创建失败",
        );
      }
      const created = {
        username: form.username,
        displayName: form.displayName,
        password: form.password,
      };
      setForm({
        username: "",
        password: "",
        displayName: "",
        slug: "",
        planKeys: [],
      });
      setCreateOpen(false);
      await copyWelcome({
        ...created,
        ok: "代理已创建，开户说明已复制，直接发给对方即可",
      });
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "代理创建失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function editRealName(agent: AgentRow) {
    const answer = await ask({
      title: `填写 ${agent.displayName} 的真实姓名`,
      message: "只在超管后台显示，用来对账。代理自己和客户看不到。",
      fields: [
        {
          name: "realName",
          label: "真实姓名",
          defaultValue: agent.realName || "",
        },
      ],
      confirmLabel: "保存",
    });
    if (!answer) return;
    const response = await fetch(`/api/admin/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: answer.realName.trim() }),
    });
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "保存失败", "err");
      return;
    }
    toast("真实姓名已保存");
    await load();
  }

  async function toggleStatus(agent: AgentRow) {
    const next = agent.status === "active" ? "disabled" : "active";
    const response = await fetch(`/api/admin/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "状态修改失败", "err");
      return;
    }
    toast(next === "active" ? "已启用" : "已停用");
    await load();
  }

  async function resetPassword(agent: AgentRow) {
    const answer = await ask({
      title: `重置 ${agent.displayName} 的登录密码`,
      message: `登录用户名 ${agent.username}。重置后旧密码立刻失效，对方已经登录的设备也会被退出，记得把新密码发给他。`,
      fields: [
        {
          name: "password",
          label: "新密码",
          required: true,
          hint: "至少 8 位。这里是明文，方便你直接复制发给代理。",
        },
        { name: "confirm", label: "再输一次", required: true },
      ],
      confirmLabel: "重置密码",
      danger: true,
    });
    if (!answer) return;
    if (answer.password.length < 8) {
      toast("新密码至少 8 位", "err");
      return;
    }
    if (answer.password !== answer.confirm) {
      toast("两次输入的新密码不一样", "err");
      return;
    }
    setBusy(`password-${agent.id}`);
    try {
      const response = await fetch(`/api/admin/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: answer.password }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "密码重置失败",
        );
      }
      toast(`${agent.displayName} 的密码已重置，记得发给对方`);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "密码重置失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function saveRedeemUrl() {
    setBusy("redeem-url");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_agent_portal", redeemUrl }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "兑换页面地址保存失败",
        );
      }
      setRedeemUrl(String(data.redeemUrl || redeemUrl));
      toast("兑换页面地址已保存");
    } catch (reason) {
      toast(
        reason instanceof Error ? reason.message : "兑换页面地址保存失败",
        "err",
      );
    } finally {
      setBusy("");
    }
  }

  function closePlans() {
    setSelectedAgent(null);
    setAgentPlans([]);
    setOverrideDraft({});
    setPlansLoading(false);
  }

  async function loadAgentPlans(agent: AgentRow) {
    setSelectedAgent(agent);
    setPlansLoading(true);
    try {
      const response = await fetch(`/api/admin/agents/${agent.id}/plans`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "套餐加载失败");
      }
      const rows = (data.list || []) as AgentPlanRow[];
      setAgentPlans(rows);
      setOverrideDraft(
        Object.fromEntries(
          rows.map((item) => [
            item.planKey,
            item.costOverrideCents == null
              ? ""
              : yuanTextFromCents(item.costOverrideCents),
          ]),
        ),
      );
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "套餐加载失败", "err");
      closePlans();
    } finally {
      setPlansLoading(false);
    }
  }

  function pricePayload(source: CatalogPlan[]) {
    return source.map((item) => {
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
  }

  async function saveDefaultPrices() {
    setBusy("defaults");
    try {
      const response = await fetch("/api/admin/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plans: pricePayload(catalog) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "默认价格保存失败");
      toast("默认成本已保存");
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "默认价格保存失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function enableForAllAgents(plans: CatalogPlan[]) {
    const ready: CatalogPlan[] = [];
    const skipped: string[] = [];
    for (const plan of plans) {
      const cents = centsFromYuanText(costDraft[plan.planKey] ?? "");
      const label = plan.paymentCountry
        ? `${plan.name} · ${regionDisplay(plan.paymentCountry, plan.regionLabel).zh}`
        : plan.name;
      if (cents == null || Number.isNaN(cents) || (plan.paymentCountry && cents <= 0)) {
        skipped.push(label);
        continue;
      }
      ready.push(plan);
    }
    if (ready.length === 0) {
      toast("先填好默认成本。成本为 0 的地区不能启用。", "err");
      return;
    }
    const names = ready
      .map((plan) =>
        plan.paymentCountry ? regionDisplay(plan.paymentCountry, plan.regionLabel).zh : plan.name,
      )
      .join("、");
    const answer = await ask({
      title: "开放给全部代理",
      message: `启用 ${names}，并让所有在营代理都能卖。${
        skipped.length ? `未定价的地区会跳过：${skipped.join("、")}。` : ""
      }`,
      confirmLabel: "启用并开放",
      cancelLabel: "取消",
    });
    if (!answer) return;
    setBusy("grant-all");
    try {
      const keys = new Set(ready.map((plan) => plan.planKey));
      const next = catalog.map((item) => (keys.has(item.planKey) ? { ...item, enabled: true } : item));
      setCatalog(next);
      const saved = await fetch("/api/admin/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plans: pricePayload(next) }),
      });
      const savedData = await saved.json();
      if (!saved.ok) throw new Error(savedData.error || "默认价格保存失败");
      const granted = await fetch("/api/admin/plans/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKeys: [...keys] }),
      });
      const grantedData = await granted.json();
      if (!granted.ok) throw new Error(grantedData.error || "开放失败");
      toast(typeof grantedData.message === "string" ? grantedData.message : "已开放给全部代理");
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "开放失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function saveAgentPlans() {
    if (!selectedAgent) return;
    setBusy("agent-plans");
    try {
      const plans = agentPlans.map((item) => {
        const raw = overrideDraft[item.planKey] ?? "";
        const cents = centsFromYuanText(raw);
        if (raw.trim() && Number.isNaN(cents as number)) {
          throw new Error(`${item.name} 的代理成本请填金额`);
        }
        return {
          planKey: item.planKey,
          enabled: item.enabled,
          costOverrideCents: raw.trim() ? cents : null,
        };
      });
      const response = await fetch(
        `/api/admin/agents/${selectedAgent.id}/plans`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plans }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "代理套餐保存失败");
      toast(`${selectedAgent.displayName} 的可售套餐已保存`);
      await load();
      await loadAgentPlans(selectedAgent);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "代理套餐保存失败", "err");
    } finally {
      setBusy("");
    }
  }

  function toggleCreatePlan(planKey: string) {
    setForm((current) => ({
      ...current,
      planKeys: current.planKeys.includes(planKey)
        ? current.planKeys.filter((item) => item !== planKey)
        : [...current.planKeys, planKey],
    }));
  }

  return (
    <div className="space-y-6">
      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">代理管理</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              代理用同一套登录页进入自己的后台改零售价。登录
              <a className="mx-1 underline" href="/login" target="_blank" rel="noreferrer">
                {loginUrl}
              </a>
              ，上手说明
              <a className="mx-1 underline" href="/start" target="_blank" rel="noreferrer">
                {startUrl}
              </a>
              。新建时会复制一份开户说明，你也可以在列表里再复制。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="km-btn km-btn-ghost" onClick={() => void load()}>
              刷新
            </button>
            <button
              type="button"
              className="km-btn"
              onClick={() => {
                setForm((current) => ({
                  ...current,
                  planKeys: catalog
                    .filter((item) => item.enabled)
                    .map((item) => item.planKey),
                }));
                setCreateOpen(true);
              }}
            >
              新建代理
            </button>
          </div>
        </div>
        <label className="block space-y-1 text-sm">
          <span>兑换页面地址</span>
          <input
            className="km-input w-full"
            placeholder="/recharge"
            value={redeemUrl}
            onChange={(event) => setRedeemUrl(event.target.value)}
          />
          <span className="block text-xs text-[var(--km-fg-muted)]">
            代理后台的「兑换卡密」按钮跳这里。默认就是本站自己的兑换页
            <code className="mx-1">/recharge</code>
            ，不用改。要换到别处才填完整网址（https:// 开头），那种会开新标签页。
          </span>
        </label>
        <button
          type="button"
          className="km-btn"
          disabled={Boolean(busy)}
          onClick={() => void saveRedeemUrl()}
        >
          {busy === "redeem-url" ? "保存中…" : "保存兑换页面地址"}
        </button>
      </section>

      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold">默认成本价</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            这是平台给代理的默认成本。代理登录后只能在自己的成本之上加零售价。
            零售价上限留空表示不限价；填了之后代理改价不能超过它，但已经高于上限的老价格照卖，会在下面的「套餐」弹窗里标出来。
          </p>
        </div>
        {catalog.length === 0 ? (
          <p className="text-sm text-[var(--km-fg-muted)]">
            还没有套餐。等自动同步，或到「接入卡台」立刻拉一次。
          </p>
        ) : (
          <PlanCostCards
            catalog={catalog}
            costDraft={costDraft}
            capDraft={capDraft}
            shelf={shelf}
            openGroups={openGroups}
            busy={busy}
            onShelf={setShelf}
            onToggleGroup={(baseKey) =>
              setOpenGroups((current) => ({ ...current, [baseKey]: !current[baseKey] }))
            }
            onCost={(planKey, value) => setCostDraft((current) => ({ ...current, [planKey]: value }))}
            onCap={(planKey, value) => setCapDraft((current) => ({ ...current, [planKey]: value }))}
            onEnabled={(planKey, enabled) =>
              setCatalog((current) =>
                current.map((item) => (item.planKey === planKey ? { ...item, enabled } : item)),
              )
            }
            onGrant={(plans) => void enableForAllAgents(plans)}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="km-btn"
            disabled={Boolean(busy) || catalog.length === 0}
            onClick={() => void saveDefaultPrices()}
          >
            {busy === "defaults" ? "保存中…" : "保存默认价格"}
          </button>
          <button
            type="button"
            className="km-btn km-btn-ghost"
            disabled={Boolean(busy) || catalog.every((plan) => !plan.enabled)}
            onClick={() => void enableForAllAgents(catalog.filter((plan) => plan.enabled))}
          >
            {busy === "grant-all" ? "开放中…" : "把已勾选的套餐开放给全部代理"}
          </button>
        </div>
      </section>

      <section className="km-panel overflow-x-auto">
        <h2 className="mb-4 text-xl font-semibold">代理账号</h2>
        {loading ? (
          <p className="text-sm text-[var(--km-fg-muted)]">加载中…</p>
        ) : (
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-3 pr-4">代理</th>
                <th className="py-3 pr-4">用户名</th>
                <th className="py-3 pr-4">店铺</th>
                <th className="py-3 pr-4">可售套餐</th>
                <th className="py-3 pr-4">状态</th>
                <th className="py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--km-fg-muted)]">
                    还没有代理，点右上角「新建代理」
                  </td>
                </tr>
              ) : null}
              {list.map((agent) => (
                <tr key={agent.id} className="border-b border-[var(--km-border)]">
                  <td className="py-3 pr-4">
                    <div>{agentIdentityLabel(agent)}</div>
                  </td>
                  <td className="py-3 pr-4 font-mono">{agent.username}</td>
                  <td className="py-3 pr-4">
                    <a className="underline" href={`/s/${agent.currentSlug}`} target="_blank" rel="noreferrer">
                      /s/{agent.currentSlug}
                    </a>
                  </td>
                  <td className="py-3 pr-4">
                    {agent.allowedPlans?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {allowedPlanLabels(agent.allowedPlans).map((label) => (
                          <span key={label} className="km-badge">
                            {label}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-[var(--km-fg-muted)]">未分配</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {agent.status === "active" ? "启用" : "停用"}
                  </td>
                  <td className="py-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() => void loadAgentPlans(agent)}
                      >
                        套餐
                      </button>
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() =>
                          void copyWelcome({
                            username: agent.username,
                            displayName: agent.displayName,
                            ok: "开户说明已复制（不含密码）",
                          })
                        }
                      >
                        复制开户说明
                      </button>
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={busy === `password-${agent.id}`}
                        onClick={() => void resetPassword(agent)}
                      >
                        {busy === `password-${agent.id}` ? "重置中…" : "重置密码"}
                      </button>
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() => void editRealName(agent)}
                      >
                        真实姓名
                      </button>
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() => void toggleStatus(agent)}
                      >
                        {agent.status === "active" ? "停用" : "启用"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedAgent ? (
        <div className="km-modal-backdrop" onClick={closePlans}>
          <div
            className="km-modal km-modal-wide"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-labelledby="agent-plans-title"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="agent-plans-title" className="text-xl font-semibold">
                  {selectedAgent.displayName} 的可售套餐
                </h2>
                <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
                  勾选后代理才能卖。成本留空则用页面上的默认成本。零售价由代理自己在
                  <a className="mx-1 underline" href="/login" target="_blank" rel="noreferrer">
                    /login
                  </a>
                  登录后改。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="km-btn km-btn-ghost"
                  disabled={plansLoading || agentPlans.length === 0}
                  onClick={() =>
                    setAgentPlans((current) =>
                      current.map((item) =>
                        item.platformEnabled ? { ...item, enabled: true } : item,
                      ),
                    )
                  }
                >
                  全选平台已启用
                </button>
                <button type="button" className="km-btn km-btn-ghost" onClick={closePlans}>
                  关闭
                </button>
              </div>
            </div>
            {plansLoading ? (
              <p className="mt-6 text-sm text-[var(--km-fg-muted)]">加载套餐…</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--km-border)]">
                      <th className="py-2 pr-3">允许销售</th>
                      <th className="py-2 pr-3">套餐</th>
                      <th className="py-2 pr-3">默认成本</th>
                      <th className="py-2 pr-3">零售价上限</th>
                      <th className="py-2 pr-3">代理成本覆盖</th>
                      <th className="py-2">当前零售价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentPlans.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[var(--km-fg-muted)]">
                          还没有套餐，先同步卡台并保存默认价格。
                        </td>
                      </tr>
                    ) : null}
                    {groupPlansByBase(withRegion(agentPlans)).flatMap((group) => {
                      const grouped =
                        group.plans.length > 1 || group.plans.some((plan) => plan.regionCapable);
                      const expanded = Boolean(openAgentGroups[group.baseKey]);
                      const openable = group.plans.filter((plan) => plan.platformEnabled);
                      const rows = [];
                      if (grouped) {
                        const allOn =
                          openable.length > 0 && openable.every((plan) => plan.enabled);
                        rows.push(
                          <tr key={`group-${group.baseKey}`} className="border-b border-[var(--km-border)]">
                            <td className="py-2 pr-3">
                              <input
                                type="checkbox"
                                checked={allOn}
                                disabled={openable.length === 0}
                                onChange={(event) => {
                                  const keys = new Set(openable.map((plan) => plan.planKey));
                                  setAgentPlans((current) =>
                                    current.map((item) =>
                                      keys.has(item.planKey)
                                        ? { ...item, enabled: event.target.checked }
                                        : item,
                                    ),
                                  );
                                }}
                              />
                            </td>
                            <td className="py-2 pr-3" colSpan={5}>
                              <button
                                type="button"
                                className="text-left"
                                onClick={() =>
                                  setOpenAgentGroups((current) => ({
                                    ...current,
                                    [group.baseKey]: !current[group.baseKey],
                                  }))
                                }
                              >
                                <b>
                                  {expanded ? "▾" : "▸"} {group.primary.name}
                                </b>
                                <span className="ml-2 text-xs text-[var(--km-fg-muted)]">
                                  整组勾选 · {group.plans.length} 个地区
                                </span>
                              </button>
                            </td>
                          </tr>,
                        );
                        if (!expanded) return rows;
                      }
                      for (const plan of group.plans) {
                        rows.push(
                          <tr key={plan.planKey} className="border-b border-[var(--km-border)]">
                            <td className="py-2 pr-3">
                              <input
                                type="checkbox"
                                checked={plan.enabled}
                                disabled={!plan.platformEnabled}
                                title={plan.platformEnabled ? undefined : "平台未启用"}
                                onChange={(event) =>
                                  setAgentPlans((current) =>
                                    current.map((item) =>
                                      item.planKey === plan.planKey
                                        ? { ...item, enabled: event.target.checked }
                                        : item,
                                    ),
                                  )
                                }
                              />
                              {plan.platformEnabled ? null : (
                                <span className="ml-2 text-xs text-[var(--km-fg-muted)]">平台未启用</span>
                              )}
                            </td>
                            <td className="py-2 pr-3">
                              {plan.regionCapable ? (
                                <RegionBadge country={plan.paymentCountry || ""} regionLabel={plan.regionLabel} />
                              ) : (
                                plan.name
                              )}
                            </td>
                            <td className="py-2 pr-3">
                              ¥{yuanTextFromCents(plan.globalCostPriceCents)}
                            </td>
                            <td className="py-2 pr-3">
                              {plan.maxRetailPriceCents
                                ? `¥${yuanTextFromCents(plan.maxRetailPriceCents)}`
                                : "不限价"}
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                className="km-input w-28"
                                inputMode="decimal"
                                placeholder="留空用默认"
                                value={overrideDraft[plan.planKey] ?? ""}
                                onChange={(event) =>
                                  setOverrideDraft((current) => ({
                                    ...current,
                                    [plan.planKey]: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td className="py-2">
                              ¥{yuanTextFromCents(plan.retailPriceCents)}
                              {isOverMaxRetailPrice(
                                plan.retailPriceCents,
                                plan.maxRetailPriceCents,
                              ) ? (
                                <span className="km-badge ml-2">已超上限</span>
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
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="km-btn km-btn-ghost" onClick={closePlans}>
                取消
              </button>
              <button
                type="button"
                className="km-btn"
                disabled={Boolean(busy) || plansLoading}
                onClick={() => void saveAgentPlans()}
              >
                {busy === "agent-plans" ? "保存中…" : "保存套餐"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <div className="km-modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div
            className="km-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-labelledby="create-agent-title"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="create-agent-title" className="text-xl font-semibold">
                  新建代理
                </h2>
                <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
                  填登录信息，并勾选这个代理能卖的套餐。
                </p>
              </div>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                onClick={() => setCreateOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-sm">
                <span>登录用户名</span>
                <input
                  className="km-input"
                  value={form.username}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      username: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>显示名</span>
                <input
                  className="km-input"
                  value={form.displayName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>初始密码（至少 8 位）</span>
                <input
                  className="km-input"
                  type="password"
                  value={form.password}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>店铺 slug（可空）</span>
                <input
                  className="km-input"
                  value={form.slug}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      slug: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium">可售套餐</p>
              {enabledCatalog.length === 0 ? (
                <p className="text-sm text-[var(--km-fg-muted)]">
                  还没有可售套餐，先同步卡台或启用成品号后再勾选。
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {enabledCatalog.map((plan) => (
                    <label
                      key={plan.planKey}
                      className="flex items-center gap-2 rounded-xl border border-[var(--km-border)] px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={form.planKeys.includes(plan.planKey)}
                        onChange={() => toggleCreatePlan(plan.planKey)}
                      />
                      <span>
                        {plan.regionCapable
                          ? `${plan.name} · ${regionDisplay(plan.paymentCountry || "", plan.regionLabel).zh}`
                          : plan.name}
                        <span className="ml-2 text-xs text-[var(--km-fg-muted)]">
                          成本 ¥{yuanTextFromCents(plan.globalCostPriceCents)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="km-btn km-btn-ghost"
                onClick={() => setCreateOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="km-btn"
                disabled={Boolean(busy)}
                onClick={() => void createAgent()}
              >
                {busy === "create" ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {dialog}
    </div>
  );
}
