"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";

type AgentPlan = {
  planKey: string;
  name: string;
  enabled: boolean;
};

type CouponWarning = { message: string; reason: string };

type CouponItem = {
  id: number;
  name: string;
  code: string;
  kind: "percent" | "threshold";
  percentZhe: number;
  thresholdCents: number;
  amountCents: number;
  maxUses: number;
  usedCount: number;
  enabled: boolean;
  planKeys: string[];
  warnings: CouponWarning[];
};

type Draft = {
  name: string;
  code: string;
  kind: "percent" | "threshold";
  percentZhe: string;
  thresholdYuan: string;
  amountYuan: string;
  unlimited: boolean;
  maxUses: string;
  planKeys: string[];
  enabled: boolean;
};

const emptyDraft = (): Draft => ({
  name: "",
  code: "",
  kind: "percent",
  percentZhe: "9",
  thresholdYuan: "",
  amountYuan: "",
  unlimited: false,
  maxUses: "20",
  planKeys: [],
  enabled: true,
});

function draftFromCoupon(item: CouponItem): Draft {
  return {
    name: item.name,
    code: item.code,
    kind: item.kind,
    percentZhe: item.kind === "percent" ? String(item.percentZhe) : "9",
    thresholdYuan:
      item.kind === "threshold" ? yuanTextFromCents(item.thresholdCents) : "",
    amountYuan: item.kind === "threshold" ? yuanTextFromCents(item.amountCents) : "",
    unlimited: item.maxUses === 0,
    maxUses: item.maxUses > 0 ? String(item.maxUses) : "20",
    planKeys: item.planKeys,
    enabled: item.enabled,
  };
}

function draftPayload(draft: Draft) {
  const thresholdCents = centsFromYuanText(draft.thresholdYuan);
  const amountCents = centsFromYuanText(draft.amountYuan);
  if (draft.kind === "threshold") {
    if (thresholdCents == null || Number.isNaN(thresholdCents)) {
      throw new Error("请填写有效的满减门槛");
    }
    if (amountCents == null || Number.isNaN(amountCents)) {
      throw new Error("请填写有效的减免金额");
    }
  }
  const percentZhe = Number(draft.percentZhe);
  return {
    name: draft.name,
    code: draft.code,
    kind: draft.kind,
    percentZhe: draft.kind === "percent" ? percentZhe : undefined,
    thresholdCents: draft.kind === "threshold" ? thresholdCents : undefined,
    amountCents: draft.kind === "threshold" ? amountCents : undefined,
    maxUses: draft.unlimited ? 0 : Number(draft.maxUses),
    unlimited: draft.unlimited,
    planKeys: draft.planKeys,
    enabled: draft.enabled,
  };
}

function couponLabel(item: Pick<CouponItem, "kind" | "percentZhe" | "thresholdCents" | "amountCents">) {
  if (item.kind === "percent") return `${item.percentZhe} 折`;
  return `满 ¥${yuanTextFromCents(item.thresholdCents)} 减 ¥${yuanTextFromCents(item.amountCents)}`;
}

export function AgentCoupons({ plans }: { plans: AgentPlan[] }) {
  const sellable = useMemo(() => plans.filter((plan) => plan.enabled), [plans]);
  const [list, setList] = useState<CouponItem[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<CouponWarning[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const data = await readApiJson<{ list?: CouponItem[] }>(
      await fetch("/api/agent/coupons", { cache: "no-store" }),
    );
    setList(data.list || []);
  }

  useEffect(() => {
    void load().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "优惠券加载失败");
    });
  }, []);

  useEffect(() => {
    if (!draft.planKeys.length) {
      setWarnings([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const payload = draftPayload(draft);
          const data = await readApiJson<{ warnings?: CouponWarning[] }>(
            await fetch("/api/agent/coupons/preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
          );
          setWarnings(data.warnings || []);
          setError("");
        } catch {
          /* 填到一半时预览失败很常见，等保存再报 */
        }
      })();
    }, 400);
    return () => window.clearTimeout(handle);
  }, [draft]);

  function togglePlan(planKey: string) {
    setDraft((current) => ({
      ...current,
      planKeys: current.planKeys.includes(planKey)
        ? current.planKeys.filter((key) => key !== planKey)
        : [...current.planKeys, planKey],
    }));
  }

  function startEdit(item: CouponItem) {
    setEditingId(item.id);
    setDraft(draftFromCoupon(item));
    setWarnings(item.warnings || []);
    setError("");
  }

  function resetForm() {
    setEditingId(null);
    setDraft(emptyDraft());
    setWarnings([]);
    setError("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = draftPayload(draft);
      if (editingId) {
        await readApiJson(
          await fetch(`/api/agent/coupons/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
        toast("优惠券已保存");
      } else {
        await readApiJson(
          await fetch("/api/agent/coupons", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
        toast("优惠券已创建");
      }
      await load();
      resetForm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(item: CouponItem) {
    setBusy(true);
    try {
      await readApiJson(
        await fetch(`/api/agent/coupons/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !item.enabled }),
        }),
      );
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="km-panel space-y-4">
      <div>
        <h2 className="text-xl font-semibold">优惠券</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          每张券必须指定套餐，可以是折扣或满减。开票和收益都按券后价算。低于成本不会拦住保存，但下单时这张券会用不了。
        </p>
      </div>

      {list.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">名称 / 券码</th>
                <th className="py-2 pr-3">规则</th>
                <th className="py-2 pr-3">套餐</th>
                <th className="py-2 pr-3">次数</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.id} className="border-b border-[var(--km-border)] align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{item.name}</div>
                    <div className="font-mono text-xs text-[var(--km-fg-muted)]">{item.code}</div>
                    {!item.enabled ? (
                      <div className="mt-1 text-xs text-[var(--km-fg-muted)]">已停用</div>
                    ) : null}
                    {item.warnings.length ? (
                      <div className="mt-1 text-xs text-[var(--km-danger)]">
                        {item.warnings.length} 条成本提醒
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">{couponLabel(item)}</td>
                  <td className="py-2 pr-3">
                    {item.planKeys
                      .map((key) => sellable.find((plan) => plan.planKey === key)?.name || key)
                      .join("、") || "—"}
                  </td>
                  <td className="py-2 pr-3">
                    {item.maxUses === 0
                      ? `已用 ${item.usedCount} / 不限`
                      : `已用 ${item.usedCount} / ${item.maxUses}`}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={busy}
                        onClick={() => startEdit(item)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={busy}
                        onClick={() => void toggleEnabled(item)}
                      >
                        {item.enabled ? "停用" : "启用"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">还没有优惠券。</p>
      )}

      <form onSubmit={(event) => void save(event)} className="space-y-4 border-t border-[var(--km-border)] pt-4">
        <h3 className="font-medium">{editingId ? "编辑优惠券" : "新建优惠券"}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span>名称</span>
            <input
              className="km-input w-full"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              maxLength={40}
              required
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>券码</span>
            <input
              className="km-input w-full font-mono uppercase"
              value={draft.code}
              onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))}
              minLength={4}
              maxLength={20}
              required
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={draft.kind === "percent" ? "km-btn" : "km-btn km-btn-ghost"}
            onClick={() => setDraft((current) => ({ ...current, kind: "percent" }))}
          >
            折扣
          </button>
          <button
            type="button"
            className={draft.kind === "threshold" ? "km-btn" : "km-btn km-btn-ghost"}
            onClick={() => setDraft((current) => ({ ...current, kind: "threshold" }))}
          >
            满减
          </button>
        </div>
        {draft.kind === "percent" ? (
          <label className="block max-w-xs space-y-1 text-sm">
            <span>几折</span>
            <input
              className="km-input w-full"
              inputMode="numeric"
              value={draft.percentZhe}
              onChange={(event) =>
                setDraft((current) => ({ ...current, percentZhe: event.target.value }))
              }
              required
            />
            <span className="text-xs text-[var(--km-fg-muted)]">8 表示 8 折，买家付原价的 80%</span>
          </label>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span>满多少元</span>
              <input
                className="km-input w-full"
                inputMode="decimal"
                value={draft.thresholdYuan}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, thresholdYuan: event.target.value }))
                }
                required
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>减多少元</span>
              <input
                className="km-input w-full"
                inputMode="decimal"
                value={draft.amountYuan}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, amountYuan: event.target.value }))
                }
                required
              />
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.unlimited}
              onChange={(event) =>
                setDraft((current) => ({ ...current, unlimited: event.target.checked }))
              }
            />
            不限次数
          </label>
          {!draft.unlimited ? (
            <label className="block space-y-1 text-sm">
              <span>可用次数</span>
              <input
                className="km-input w-28"
                inputMode="numeric"
                value={draft.maxUses}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxUses: event.target.value }))
                }
                required
              />
            </label>
          ) : null}
        </div>
        <div className="space-y-2">
          <p className="text-sm">适用套餐（必选）</p>
          {sellable.length ? (
            <div className="flex flex-wrap gap-3">
              {sellable.map((plan) => (
                <label key={plan.planKey} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.planKeys.includes(plan.planKey)}
                    onChange={() => togglePlan(plan.planKey)}
                  />
                  {plan.name}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[var(--km-fg-muted)]">
              还没有可售套餐。先让管理员开放套餐，再来建券。
            </p>
          )}
        </div>
        {warnings.length ? (
          <ul className="space-y-1 text-sm text-[var(--km-danger)]">
            {warnings.map((item) => (
              <li key={item.message}>{item.message}</li>
            ))}
          </ul>
        ) : draft.planKeys.length ? (
          <p className="text-sm text-[var(--km-fg-muted)]">按当前售价和通道费率，还没有低于成本的提醒。</p>
        ) : null}
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button className="km-btn km-btn-primary" disabled={busy || !sellable.length}>
            {busy ? "保存中…" : editingId ? "保存优惠券" : "创建优惠券"}
          </button>
          {editingId ? (
            <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={resetForm}>
              取消编辑
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
