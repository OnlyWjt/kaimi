"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import {
  moneyYuan,
  type AgentCouponItem,
  type AgentCouponWarning,
  type AgentPlanRow,
} from "@/lib/agent-console-core";
import type { CouponPreviewTicket } from "@/lib/coupon-core";
import { readApiJson } from "@/lib/http-error";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";

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
  percentZhe: "8",
  thresholdYuan: "",
  amountYuan: "",
  unlimited: false,
  maxUses: "20",
  planKeys: [],
  enabled: true,
});

function draftFromCoupon(item: AgentCouponItem): Draft {
  return {
    name: item.name,
    code: item.code,
    kind: item.kind,
    percentZhe: item.kind === "percent" ? String(item.percentZhe) : "8",
    thresholdYuan: item.kind === "threshold" ? yuanTextFromCents(item.thresholdCents) : "",
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
  return {
    name: draft.name,
    code: draft.code,
    kind: draft.kind,
    percentZhe: draft.kind === "percent" ? Number(draft.percentZhe) : undefined,
    thresholdCents: draft.kind === "threshold" ? thresholdCents : undefined,
    amountCents: draft.kind === "threshold" ? amountCents : undefined,
    maxUses: draft.unlimited ? 0 : Number(draft.maxUses),
    unlimited: draft.unlimited,
    planKeys: draft.planKeys,
    enabled: draft.enabled,
  };
}

export function AgentCouponComposer({ couponId }: { couponId?: number }) {
  const router = useRouter();
  const [plans, setPlans] = useState<AgentPlanRow[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [warnings, setWarnings] = useState<AgentCouponWarning[]>([]);
  const [tickets, setTickets] = useState<CouponPreviewTicket[]>([]);
  const [ticketPlan, setTicketPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(!couponId);

  const sellable = useMemo(() => plans.filter((plan) => plan.enabled), [plans]);
  const ticket =
    tickets.find((item) => item.planKey === ticketPlan) || tickets[0] || null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const planData = await readApiJson<{ list?: AgentPlanRow[] }>(
          await fetch("/api/agent/plans", { cache: "no-store" }),
        );
        if (cancelled) return;
        const next = planData.list || [];
        setPlans(next);
        if (couponId) {
          const data = await readApiJson<{ coupon: AgentCouponItem }>(
            await fetch(`/api/agent/coupons/${couponId}`, { cache: "no-store" }),
          );
          if (cancelled) return;
          setDraft(draftFromCoupon(data.coupon));
          setWarnings(data.coupon.warnings || []);
          setTicketPlan(data.coupon.planKeys[0] || "");
        }
        setReady(true);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "加载失败");
          setReady(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [couponId]);

  useEffect(() => {
    if (!draft.planKeys.length) {
      setWarnings([]);
      setTickets([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const payload = draftPayload(draft);
          const data = await readApiJson<{
            warnings?: AgentCouponWarning[];
            tickets?: CouponPreviewTicket[];
          }>(
            await fetch("/api/agent/coupons/preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
          );
          setWarnings(data.warnings || []);
          setTickets(data.tickets || []);
          setTicketPlan((current) =>
            data.tickets?.some((item) => item.planKey === current)
              ? current
              : data.tickets?.[0]?.planKey || "",
          );
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

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = draftPayload(draft);
      if (couponId) {
        await readApiJson(
          await fetch(`/api/agent/coupons/${couponId}`, {
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
      router.push("/agent/sell");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const below = warnings.some((item) => item.reason === "below_cost");
  const missed = warnings.some((item) => item.reason === "threshold_unmet");

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>{couponId ? "改这张券" : "做一张店里的券"}</h1>
          <p>左边定规则，右边立刻按买 1 张算账。低于成本只提醒，下单时才硬拦。</p>
        </div>
        <Link href="/agent/sell" className="km-btn km-btn-ghost">
          回到售价与优惠
        </Link>
      </header>
      {!ready ? <p className="text-sm text-[var(--km-fg-muted)]">正在打开…</p> : null}
      <form className="km-acp-composer" onSubmit={(event) => void save(event)}>
        <section className="km-panel space-y-5">
          <div className="km-acp-kinds">
            <button
              type="button"
              className={`km-acp-kind${draft.kind === "percent" ? " is-on" : ""}`}
              onClick={() => setDraft((current) => ({ ...current, kind: "percent" }))}
            >
              <b>折扣</b>
              <span>按几折卖。8 就是买家付原价的 80%。</span>
            </button>
            <button
              type="button"
              className={`km-acp-kind${draft.kind === "threshold" ? " is-on" : ""}`}
              onClick={() => setDraft((current) => ({ ...current, kind: "threshold" }))}
            >
              <b>满减</b>
              <span>满到门槛再减一笔。适合凑单，不适合无脑砍。</span>
            </button>
          </div>

          <div className="km-acp-fields">
            <label>
              给自己看的名字
              <input
                className="km-input"
                value={draft.name}
                maxLength={40}
                required
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label>
              买家要填的券码
              <input
                className="km-input font-mono uppercase"
                value={draft.code}
                minLength={4}
                maxLength={20}
                required
                onChange={(event) =>
                  setDraft((current) => ({ ...current, code: event.target.value }))
                }
              />
            </label>
            {draft.kind === "percent" ? (
              <label>
                几折
                <input
                  className="km-input"
                  inputMode="numeric"
                  value={draft.percentZhe}
                  required
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, percentZhe: event.target.value }))
                  }
                />
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label>
                  满多少元
                  <input
                    className="km-input"
                    inputMode="decimal"
                    value={draft.thresholdYuan}
                    required
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, thresholdYuan: event.target.value }))
                    }
                  />
                </label>
                <label>
                  减多少元
                  <input
                    className="km-input"
                    inputMode="decimal"
                    value={draft.amountYuan}
                    required
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, amountYuan: event.target.value }))
                    }
                  />
                </label>
              </div>
            )}
            <div>
              <p className="mb-2 text-sm">用在哪些套餐</p>
              {sellable.length ? (
                <div className="km-acp-chips">
                  {sellable.map((plan) => (
                    <button
                      key={plan.planKey}
                      type="button"
                      className={`km-acp-chip${draft.planKeys.includes(plan.planKey) ? " is-on" : ""}`}
                      onClick={() => togglePlan(plan.planKey)}
                    >
                      {plan.name}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--km-fg-muted)]">
                  还没有可售套餐。先让管理员开放套餐，再来建券。
                </p>
              )}
            </div>
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
              <label>
                可用次数
                <input
                  className="km-input"
                  inputMode="numeric"
                  value={draft.maxUses}
                  required
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, maxUses: event.target.value }))
                  }
                />
              </label>
            ) : null}
          </div>

          {below ? (
            <div className="km-acp-warn">
              {warnings.find((item) => item.reason === "below_cost")?.message ||
                "有套餐用这张券后，扣完通道费会低于成本。可以保存，买家下单时这张券会用不了。"}
            </div>
          ) : missed ? (
            <div className="km-acp-warn">
              {warnings.find((item) => item.reason === "threshold_unmet")?.message}
            </div>
          ) : draft.planKeys.length ? (
            <p className="text-sm text-[var(--km-fg-muted)]">按当前售价，勾选的套餐用这张券不会亏。</p>
          ) : (
            <p className="text-sm text-[var(--km-fg-muted)]">先勾选套餐，右边才会算账。</p>
          )}
          {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}

          <div className="km-acp-tools">
            <button className="km-btn km-btn-primary" disabled={busy || !sellable.length}>
              {busy ? "保存中…" : couponId ? "保存" : "创建并启用"}
            </button>
            <Link href="/agent/sell" className="km-btn km-btn-ghost">
              取消
            </Link>
          </div>
        </section>

        <aside className="km-acp-ticket">
          <small className="text-[var(--km-fg-muted)]">买家付的时候会看到</small>
          <h3>
            {draft.kind === "percent"
              ? `${draft.percentZhe || "—"} 折`
              : `减 ¥${draft.amountYuan || "0"}`}
          </h3>
          <code>{draft.code.trim() ? draft.code.trim().toUpperCase() : "券码"}</code>
          {tickets.length > 1 ? (
            <div className="km-acp-chips" style={{ marginTop: "0.85rem" }}>
              {tickets.map((item) => (
                <button
                  key={item.planKey}
                  type="button"
                  className={`km-acp-chip${ticket?.planKey === item.planKey ? " is-on" : ""}`}
                  onClick={() => setTicketPlan(item.planKey)}
                >
                  {item.planName}
                </button>
              ))}
            </div>
          ) : null}
          <dl>
            <div>
              <dt>{ticket ? `${ticket.planName} 原价` : "原价"}</dt>
              <dd>{ticket ? moneyYuan(ticket.listCents) : "—"}</dd>
            </div>
            <div>
              <dt>优惠</dt>
              <dd>
                {ticket
                  ? ticket.applied
                    ? `−${moneyYuan(ticket.discountCents)}`
                    : "未生效"
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>券后价</dt>
              <dd>{ticket ? moneyYuan(ticket.goodsCents) : "—"}</dd>
            </div>
            <div>
              <dt>开票实付</dt>
              <dd>{ticket ? moneyYuan(ticket.invoicePayCents) : "—"}</dd>
            </div>
            <div>
              <dt>预估收益</dt>
              <dd>{ticket ? moneyYuan(ticket.earningCents) : "—"}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-[var(--km-fg-muted)]">按当前售价买 1 张、支付宝通道费估算。</p>
        </aside>
      </form>
    </>
  );
}
