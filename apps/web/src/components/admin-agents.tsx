"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type AgentRow = {
  id: number;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  currentSlug: string;
  notes: string;
  lastLoginAt: string | null;
  createdAt: string;
};

type AgentPlanRow = {
  planKey: string;
  name: string;
  globalCostPriceCents: number;
  cardplatformSellable: boolean;
  enabled: boolean;
  costOverrideCents: number | null;
};

export function AdminAgents() {
  const [list, setList] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  const [agentPlans, setAgentPlans] = useState<AgentPlanRow[]>([]);
  const planRequestId = useRef(0);
  const [form, setForm] = useState({
    username: "",
    password: "",
    displayName: "",
    slug: "",
  });

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/agents", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "代理列表加载失败");
      setList(data.list || []);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "代理列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
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
      setForm({ username: "", password: "", displayName: "", slug: "" });
      setMessage("代理已创建");
      await load();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "代理创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(agent: AgentRow) {
    setMessage("");
    const next = agent.status === "active" ? "disabled" : "active";
    const response = await fetch(`/api/admin/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "状态修改失败");
      return;
    }
    await load();
  }

  async function loadAgentPlans(agent: AgentRow) {
    const requestId = ++planRequestId.current;
    setSelectedAgent(agent);
    setAgentPlans([]);
    const response = await fetch(`/api/admin/agents/${agent.id}/plans`, {
      cache: "no-store",
    });
    const data = await response.json();
    if (requestId !== planRequestId.current) return;
    if (!response.ok) {
      setMessage(data.error || "套餐加载失败");
      return;
    }
    setAgentPlans(data.list || []);
  }

  async function saveAgentPlan(agentId: number, plan: AgentPlanRow) {
    setBusy(true);
    const response = await fetch(
      `/api/admin/agents/${agentId}/plans/${encodeURIComponent(plan.planKey)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: plan.enabled,
          costOverrideCents: plan.costOverrideCents,
        }),
      },
    );
    const data = await response.json();
    setBusy(false);
    if (!response.ok) {
      setMessage(data.error || "代理套餐保存失败");
      return;
    }
    setMessage(`${selectedAgent?.displayName} 的 ${plan.name} 已保存`);
    if (selectedAgent?.id === agentId) await loadAgentPlans(selectedAgent);
  }

  return (
    <div className="space-y-6">
      <section className="km-panel">
        <h2 className="text-xl font-semibold">创建代理</h2>
        <form onSubmit={create} className="mt-4 grid gap-3 md:grid-cols-2">
          <input
            className="km-input"
            placeholder="登录用户名"
            value={form.username}
            onChange={(event) =>
              setForm((current) => ({ ...current, username: event.target.value }))
            }
            required
          />
          <input
            className="km-input"
            placeholder="代理显示名"
            value={form.displayName}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                displayName: event.target.value,
              }))
            }
            required
          />
          <input
            className="km-input"
            type="password"
            placeholder="初始密码（至少 8 位）"
            value={form.password}
            onChange={(event) =>
              setForm((current) => ({ ...current, password: event.target.value }))
            }
            minLength={8}
            required
          />
          <input
            className="km-input"
            placeholder="店铺 slug（可留空自动生成）"
            value={form.slug}
            onChange={(event) =>
              setForm((current) => ({ ...current, slug: event.target.value }))
            }
          />
          <div className="md:col-span-2">
            <button className="km-btn km-btn-primary" disabled={busy}>
              {busy ? "创建中…" : "创建代理"}
            </button>
          </div>
        </form>
      </section>

      {message ? <div className="km-panel text-sm">{message}</div> : null}

      <section className="km-panel overflow-x-auto">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">代理账号</h2>
          <button type="button" className="km-btn km-btn-ghost" onClick={load}>
            刷新
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-[var(--km-fg-muted)]">加载中…</p>
        ) : (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-3 pr-4">代理</th>
                <th className="py-3 pr-4">用户名</th>
                <th className="py-3 pr-4">店铺链接</th>
                <th className="py-3 pr-4">状态</th>
                <th className="py-3 pr-4">最后登录</th>
                <th className="py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((agent) => (
                <tr key={agent.id} className="border-b border-[var(--km-border)]">
                  <td className="py-3 pr-4">{agent.displayName}</td>
                  <td className="py-3 pr-4">{agent.username}</td>
                  <td className="py-3 pr-4">/s/{agent.currentSlug}</td>
                  <td className="py-3 pr-4">
                    {agent.status === "active" ? "启用" : "禁用"}
                  </td>
                  <td className="py-3 pr-4">{agent.lastLoginAt || "—"}</td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() => loadAgentPlans(agent)}
                      >
                        配置套餐
                      </button>
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        onClick={() => toggleStatus(agent)}
                      >
                        {agent.status === "active" ? "禁用" : "启用"}
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
        <section className="km-panel space-y-4">
          <div>
            <h2 className="text-xl font-semibold">
              {selectedAgent.displayName} 的套餐
            </h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              留空使用平台成本；首次启用时，零售价初始化为代理成本，代理可再自行加价。
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {agentPlans.map((plan) => (
              <article key={plan.planKey} className="space-y-3 rounded-xl border border-[var(--km-border)] p-4">
                <div>
                  <h3 className="font-semibold">{plan.name}</h3>
                  <p className="text-xs text-[var(--km-fg-muted)]">
                    平台成本 ¥{(plan.globalCostPriceCents / 100).toFixed(2)} ·
                    卡台{plan.cardplatformSellable ? "可售" : "不可售"}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
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
                  允许代理销售
                </label>
                <label className="block space-y-1 text-sm">
                  <span>代理成本覆盖（元）</span>
                  <input
                    className="km-input w-full"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="留空使用平台成本"
                    value={
                      plan.costOverrideCents === null
                        ? ""
                        : (plan.costOverrideCents / 100).toFixed(2)
                    }
                    onChange={(event) =>
                      setAgentPlans((current) =>
                        current.map((item) =>
                          item.planKey === plan.planKey
                            ? {
                                ...item,
                                costOverrideCents: event.target.value
                                  ? Math.round(Number(event.target.value) * 100)
                                  : null,
                              }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="km-btn km-btn-primary w-full"
                  disabled={busy}
                  onClick={() => saveAgentPlan(selectedAgent.id, plan)}
                >
                  保存
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
