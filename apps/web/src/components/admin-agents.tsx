"use client";

import { useEffect, useMemo, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";

type AgentRow = {
  id: number;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  currentSlug: string;
  lastLoginAt: string | null;
  allowedPlans: Array<{ planKey: string; name: string }>;
};

type CatalogPlan = {
  planKey: string;
  name: string;
  enabled: boolean;
  cardplatformSellable: boolean;
  globalCostPriceCents: number;
};

type AgentPlanRow = {
  planKey: string;
  name: string;
  globalCostPriceCents: number;
  cardplatformSellable: boolean;
  enabled: boolean;
  costOverrideCents: number | null;
  retailPriceCents: number;
};

export function AdminAgents() {
  const { ask, dialog } = useAskDialog();
  const [list, setList] = useState<AgentRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogPlan[]>([]);
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  const [agentPlans, setAgentPlans] = useState<AgentPlanRow[]>([]);
  const [overrideDraft, setOverrideDraft] = useState<Record<string, string>>({});
  const [plansLoading, setPlansLoading] = useState(false);
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

  const enabledCatalog = useMemo(
    () => catalog.filter((item) => item.cardplatformSellable || item.enabled),
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
      setForm({
        username: "",
        password: "",
        displayName: "",
        slug: "",
        planKeys: [],
      });
      setCreateOpen(false);
      toast("代理已创建，可把登录地址发给对方");
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "代理创建失败", "err");
    } finally {
      setBusy("");
    }
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

  async function saveDefaultPrices() {
    setBusy("defaults");
    try {
      const plans = catalog.map((item) => {
        const cents = centsFromYuanText(costDraft[item.planKey] ?? "");
        if (cents == null || Number.isNaN(cents)) {
          throw new Error(`${item.name} 的默认成本请填金额`);
        }
        return {
          planKey: item.planKey,
          name: item.name,
          globalCostPriceCents: cents,
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
      toast("默认成本已保存");
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "默认价格保存失败", "err");
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
              代理用同一套登录页进入自己的后台改零售价。登录地址：
              <a className="ml-1 underline" href="/login" target="_blank" rel="noreferrer">
                {loginUrl}
              </a>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="km-btn km-btn-ghost" onClick={() => void load()}>
              刷新
            </button>
            <button
              type="button"
              className="km-btn"
              onClick={() => setCreateOpen(true)}
            >
              新建代理
            </button>
          </div>
        </div>
        <label className="block space-y-1 text-sm">
          <span>兑换页面地址</span>
          <input
            className="km-input w-full"
            placeholder="https://cdk.example.com/agent"
            value={redeemUrl}
            onChange={(event) => setRedeemUrl(event.target.value)}
          />
          <span className="block text-xs text-[var(--km-fg-muted)]">
            代理后台的「兑换卡密」按钮跳这里。页面在卡台那边，换域名改这里就行。
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
          disabled={Boolean(busy) || catalog.length === 0}
          onClick={() => void saveDefaultPrices()}
        >
          {busy === "defaults" ? "保存中…" : "保存默认价格"}
        </button>
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
                  <td className="py-3 pr-4">{agent.displayName}</td>
                  <td className="py-3 pr-4 font-mono">{agent.username}</td>
                  <td className="py-3 pr-4">
                    <a className="underline" href={`/s/${agent.currentSlug}`} target="_blank" rel="noreferrer">
                      /s/{agent.currentSlug}
                    </a>
                  </td>
                  <td className="py-3 pr-4">
                    {agent.allowedPlans?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {agent.allowedPlans.map((plan) => (
                          <span key={plan.planKey} className="km-badge">
                            {plan.name}
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
                        disabled={busy === `password-${agent.id}`}
                        onClick={() => void resetPassword(agent)}
                      >
                        {busy === `password-${agent.id}` ? "重置中…" : "重置密码"}
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
              <button type="button" className="km-btn km-btn-ghost" onClick={closePlans}>
                关闭
              </button>
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
                      <th className="py-2 pr-3">代理成本覆盖</th>
                      <th className="py-2">当前零售价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentPlans.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-[var(--km-fg-muted)]">
                          还没有套餐，先同步卡台并保存默认价格。
                        </td>
                      </tr>
                    ) : null}
                    {agentPlans.map((plan) => (
                      <tr key={plan.planKey} className="border-b border-[var(--km-border)]">
                        <td className="py-2 pr-3">
                          <input
                            type="checkbox"
                            checked={plan.enabled}
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
                        </td>
                        <td className="py-2 pr-3">
                          {plan.name}
                          <span className="ml-2 font-mono text-xs text-[var(--km-fg-muted)]">
                            {plan.planKey}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          ¥{yuanTextFromCents(plan.globalCostPriceCents)}
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
                        </td>
                      </tr>
                    ))}
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
                  还没有可售套餐，先同步卡台再勾选。
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
                        {plan.name}
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
