"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import {
  UsageStatsPanel,
  type UsageStatsPayload,
} from "@/components/usage-stats-panel";
import { readApiJson } from "@/lib/http-error";

type AgentOption = { id: number; displayName: string };
type Preset = "today" | "week" | "month" | "custom";

function localYmd(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function mondayYmd(date = new Date()) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = copy.getDay();
  copy.setDate(copy.getDate() - (weekday === 0 ? 6 : weekday - 1));
  return localYmd(copy);
}

function monthStartYmd(date = new Date()) {
  return localYmd(new Date(date.getFullYear(), date.getMonth(), 1));
}

export function AdminUsageStats() {
  const [preset, setPreset] = useState<Preset>("month");
  const [agentId, setAgentId] = useState(0);
  const [start, setStart] = useState(monthStartYmd);
  const [end, setEnd] = useState(localYmd);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [data, setData] = useState<UsageStatsPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => {
    if (preset === "today") return { start: localYmd(), end: localYmd() };
    if (preset === "week") return { start: mondayYmd(), end: localYmd() };
    if (preset === "month") return { start: monthStartYmd(), end: localYmd() };
    return { start, end };
  }, [preset, start, end]);

  useEffect(() => {
    let cancelled = false;
    async function loadAgents() {
      try {
        const payload = await readApiJson<{ list?: AgentOption[] }>(
          await fetch("/api/admin/agents", { cache: "no-store" }),
        );
        if (!cancelled) setAgents(payload.list || []);
      } catch {
        if (!cancelled) setAgents([]);
      }
    }
    void loadAgents();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setBusy(true);
      setError("");
      try {
        const qs = new URLSearchParams({
          start: range.start,
          end: range.end,
        });
        if (agentId > 0) qs.set("agentId", String(agentId));
        const payload = await readApiJson<UsageStatsPayload>(
          await fetch(`/api/admin/usage/stats?${qs}`, { cache: "no-store" }),
        );
        if (!cancelled) setData(payload);
      } catch (reason) {
        if (!cancelled) {
          setData(null);
          setError(reason instanceof Error ? reason.message : "统计加载失败");
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [range.start, range.end, agentId]);

  async function toggleCoupon(id: number, enabled: boolean) {
    try {
      await readApiJson(
        await fetch(`/api/admin/coupons/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }),
      );
      setData((current) =>
        current
          ? {
              ...current,
              coupons: current.coupons.map((row) =>
                row.id === id ? { ...row, enabled } : row,
              ),
            }
          : current,
      );
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新失败");
    }
  }

  return (
    <div className="space-y-6">
      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold">用量统计</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            看下单、发卡和未兑换积压。钱在「收益统计」。优惠券只能停用，不能改代理设的金额。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["today", "今天"],
              ["week", "本周"],
              ["month", "本月"],
              ["custom", "自定义"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`km-tab ${preset === id ? "km-tab-active" : ""}`}
              onClick={() => setPreset(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {preset === "custom" ? (
            <>
              <input
                className="km-input"
                type="date"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
              <input
                className="km-input"
                type="date"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </>
          ) : (
            <p className="self-center text-sm text-[var(--km-fg-muted)] md:col-span-2">
              {range.start} 至 {range.end}
            </p>
          )}
          <select
            className="km-input"
            value={agentId}
            onChange={(event) => setAgentId(Number(event.target.value))}
          >
            <option value={0}>全部代理</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName}
              </option>
            ))}
          </select>
        </div>
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
        {busy ? <p className="text-xs text-[var(--km-fg-muted)]">正在汇总…</p> : null}
      </section>
      {data ? (
        <section className="km-panel space-y-4">
          <UsageStatsPanel
            data={data}
            showAgents={agentId === 0}
            couponAction={(coupon) => (
              <button
                type="button"
                className="km-btn km-btn-ghost"
                onClick={() => void toggleCoupon(coupon.id, !coupon.enabled)}
              >
                {coupon.enabled ? "停用" : "启用"}
              </button>
            )}
          />
        </section>
      ) : null}
    </div>
  );
}
