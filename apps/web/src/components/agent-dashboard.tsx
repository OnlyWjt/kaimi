"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";

type AgentProfile = {
  username: string;
  displayName: string;
  currentSlug: string;
};

type AgentPlan = {
  planKey: string;
  name: string;
  costPriceCents: number;
  retailPriceCents: number;
  enabled: boolean;
  cardplatformSellable: boolean;
};

type AgentCdk = {
  id: number;
  code: string;
  planKey: string;
  status: string;
  orderNo: string;
  issuedAt: string;
};

type EarningsData = {
  summary: {
    orderCount: number;
    grossCents: number;
    paymentFeeCents: number;
    earningCents: number;
    pendingCents: number;
    settledCents: number;
  };
  list: Array<{
    id: number;
    confirmedAt: string;
    orderNo: string;
    productName: string;
    grossCents: number;
    paymentFeeCents: number;
    earningCents: number;
    feeReconcileStatus: string;
    status: string;
  }>;
};

type AgentSettlement = {
  id: number;
  settlementNo: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  status: string;
  paidAt: string | null;
};

export function AgentDashboard({ initialProfile }: { initialProfile: AgentProfile }) {
  const router = useRouter();
  const [slug, setSlug] = useState(initialProfile.currentSlug);
  const [savedSlug, setSavedSlug] = useState(initialProfile.currentSlug);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [plans, setPlans] = useState<AgentPlan[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [cdks, setCdks] = useState<AgentCdk[]>([]);
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [settlements, setSettlements] = useState<AgentSettlement[]>([]);
  const [earningRange, setEarningRange] = useState("7d");

  async function loadPlans() {
    const response = await fetch("/api/agent/plans", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "套餐加载失败");
    const next = (data.list || []) as AgentPlan[];
    setPlans(next);
    setPrices(
      Object.fromEntries(
        next.map((plan) => [plan.planKey, yuanTextFromCents(plan.retailPriceCents)]),
      ),
    );
  }

  function earningQuery() {
    const now = new Date();
    const end = now.toISOString().slice(0, 10);
    if (earningRange === "all") return "";
    if (earningRange === "today") return `&start=${end}&end=${end}`;
    if (earningRange === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString()
        .slice(0, 10);
      return `&start=${start}&end=${end}`;
    }
    const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return `&start=${start}&end=${end}`;
  }

  async function loadSales() {
    const range = earningQuery();
    const [cdkResponse, earningsResponse, settlementResponse] = await Promise.all([
      fetch("/api/agent/cdks?pageSize=20", { cache: "no-store" }),
      fetch(`/api/agent/earnings?pageSize=20${range}`, { cache: "no-store" }),
      fetch("/api/agent/settlements", { cache: "no-store" }),
    ]);
    const [cdkData, earningsData, settlementData] = await Promise.all([
      cdkResponse.json(),
      earningsResponse.json(),
      settlementResponse.json(),
    ]);
    if (!cdkResponse.ok) throw new Error(cdkData.error || "卡密加载失败");
    if (!earningsResponse.ok) {
      throw new Error(earningsData.error || "收益加载失败");
    }
    if (!settlementResponse.ok) {
      throw new Error(settlementData.error || "结算记录加载失败");
    }
    setCdks(cdkData.list || []);
    setEarnings(earningsData);
    setSettlements(settlementData.list || []);
  }

  useEffect(() => {
    void Promise.all([loadPlans(), loadSales()]).catch((reason) => {
      setMessage(reason instanceof Error ? reason.message : "套餐加载失败");
    });
    // loadPlans/loadSales close over current earningRange
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earningRange]);

  async function saveSlug(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/agent/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setSlug(data.slug);
      setSavedSlug(data.slug);
      toast("店铺链接已更新");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.replace("/login");
    router.refresh();
  }

  async function savePrices() {
    setBusy(true);
    setMessage("");
    try {
      for (const plan of plans) {
        if (!plan.enabled) continue;
        const cents = centsFromYuanText(prices[plan.planKey] ?? "");
        if (cents == null || Number.isNaN(cents)) {
          throw new Error(`${plan.name} 请填写零售价`);
        }
        if (cents < plan.costPriceCents) {
          throw new Error(
            `${plan.name} 不能低于成本 ¥${yuanTextFromCents(plan.costPriceCents)}`,
          );
        }
        const response = await fetch(
          `/api/agent/plans/${encodeURIComponent(plan.planKey)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ retailPriceCents: cents }),
          },
        );
        const data = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof data.error === "string" ? data.error : `${plan.name} 保存失败`,
          );
        }
      }
      await loadPlans();
      toast("零售价已保存");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "价格保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function revealCdk(id: number) {
    const response = await fetch(`/api/agent/cdks/${id}/reveal`, {
      method: "POST",
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "卡密读取失败");
      return;
    }
    setCdks((current) =>
      current.map((item) => (item.id === id ? { ...item, code: data.code } : item)),
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="km-page-title">{initialProfile.displayName}</h1>
          <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
            登录账号 {initialProfile.username}。店铺零售价在下面改，客户从
            <a className="mx-1 underline" href={`/s/${savedSlug}`} target="_blank" rel="noreferrer">
              /s/{savedSlug}
            </a>
            下单。
          </p>
        </div>
        <button type="button" className="km-btn km-btn-ghost" onClick={logout}>
          退出登录
        </button>
      </header>

      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold">店铺零售价</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            这是你挂出去的售价，必须高于平台给你的成本。改完点一次保存即可。
          </p>
        </div>
        {plans.length === 0 ? (
          <p className="text-sm text-[var(--km-fg-muted)]">
            还没有可售套餐。让管理员在「代理管理」里给你勾选套餐。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)]">
                  <th className="py-2 pr-3">套餐</th>
                  <th className="py-2 pr-3">代理成本</th>
                  <th className="py-2 pr-3">零售价（元）</th>
                  <th className="py-2">状态</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.planKey} className="border-b border-[var(--km-border)]">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{plan.name}</div>
                      <div className="font-mono text-xs text-[var(--km-fg-muted)]">
                        {plan.planKey}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      ¥{yuanTextFromCents(plan.costPriceCents)}
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        className="km-input w-28"
                        inputMode="decimal"
                        value={prices[plan.planKey] ?? ""}
                        disabled={!plan.enabled}
                        onChange={(event) =>
                          setPrices((current) => ({
                            ...current,
                            [plan.planKey]: event.target.value,
                          }))
                        }
                      />
                    </td>
                    <td className="py-2">
                      {!plan.enabled
                        ? "未开放"
                        : plan.cardplatformSellable
                          ? "可售"
                          : "卡台暂不可售"}
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
          disabled={busy || plans.length === 0}
          onClick={() => void savePrices()}
        >
          {busy ? "保存中…" : "保存零售价"}
        </button>
      </section>

      <section className="km-panel max-w-2xl space-y-4">
        <div>
          <h2 className="text-xl font-semibold">我的店铺链接</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            只能修改链接末尾的 slug。旧链接会跳到新链接。
          </p>
        </div>
        <form onSubmit={saveSlug} className="space-y-3">
          <label className="block space-y-2">
            <span className="text-sm">店铺 slug</span>
            <input
              className="km-input w-full"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              minLength={3}
              maxLength={32}
              required
            />
          </label>
          <p className="break-all text-sm text-[var(--km-fg-muted)]">
            当前链接：/s/{savedSlug}
          </p>
          {message ? <p className="text-sm">{message}</p> : null}
          <button className="km-btn km-btn-primary" disabled={busy}>
            {busy ? "保存中…" : "保存链接"}
          </button>
        </form>
      </section>

      <section className="km-panel space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">收益</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              已按代理成本价和支付渠道手续费计算。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["today", "今天"],
                ["7d", "近 7 天"],
                ["month", "本月"],
                ["all", "全部"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="km-btn km-btn-ghost"
                disabled={busy || earningRange === value}
                onClick={() => setEarningRange(value)}
              >
                {label}
              </button>
            ))}
            <a
              className="km-btn km-btn-ghost"
              href={`/api/agent/earnings/export.xlsx?${earningQuery().replace(/^&/, "")}`}
            >
              导出 Excel
            </a>
          </div>
        </div>
        {earnings ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="km-stat">
                <p className="text-sm text-[var(--km-fg-muted)]">成交订单</p>
                <p className="mt-1 text-xl font-semibold">
                  {earnings.summary.orderCount}
                </p>
              </div>
              <div className="km-stat">
                <p className="text-sm text-[var(--km-fg-muted)]">成交额</p>
                <p className="mt-1 text-xl font-semibold">
                  ¥{(earnings.summary.grossCents / 100).toFixed(2)}
                </p>
              </div>
              <div className="km-stat">
                <p className="text-sm text-[var(--km-fg-muted)]">手续费</p>
                <p className="mt-1 text-xl font-semibold">
                  ¥{(earnings.summary.paymentFeeCents / 100).toFixed(2)}
                </p>
              </div>
              <div className="km-stat">
                <p className="text-sm text-[var(--km-fg-muted)]">待结算收益</p>
                <p className="mt-1 text-xl font-semibold">
                  ¥{(earnings.summary.pendingCents / 100).toFixed(2)}
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--km-border)]">
                    <th className="py-2 pr-3">时间</th>
                    <th className="py-2 pr-3">订单</th>
                    <th className="py-2 pr-3">套餐</th>
                    <th className="py-2 pr-3">实付</th>
                    <th className="py-2 pr-3">手续费</th>
                    <th className="py-2 pr-3">收益</th>
                    <th className="py-2">对账</th>
                  </tr>
                </thead>
                <tbody>
                  {earnings.list.map((item) => (
                    <tr key={item.id} className="border-b border-[var(--km-border)]">
                      <td className="py-2 pr-3">{item.confirmedAt}</td>
                      <td className="py-2 pr-3">{item.orderNo}</td>
                      <td className="py-2 pr-3">{item.productName}</td>
                      <td className="py-2 pr-3">
                        ¥{(item.grossCents / 100).toFixed(2)}
                      </td>
                      <td className="py-2 pr-3">
                        ¥{(item.paymentFeeCents / 100).toFixed(2)}
                      </td>
                      <td className="py-2 pr-3">
                        ¥{(item.earningCents / 100).toFixed(2)}
                      </td>
                      <td className="py-2">{item.feeReconcileStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>

      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">返佣结算记录</h2>
        <div className="space-y-3">
          {settlements.map((settlement) => (
            <div
              key={settlement.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--km-border)] p-4 text-sm"
            >
              <div>
                <p className="font-mono">{settlement.settlementNo}</p>
                <p className="mt-1 text-[var(--km-fg-muted)]">
                  {settlement.periodStart.slice(0, 10)} 至{" "}
                  {settlement.periodEnd.slice(0, 10)}
                </p>
              </div>
              <div className="text-right">
                <p className="font-semibold">
                  ¥{(settlement.amountCents / 100).toFixed(2)}
                </p>
                <p className="text-[var(--km-fg-muted)]">{settlement.status}</p>
              </div>
            </div>
          ))}
          {!settlements.length ? (
            <p className="text-sm text-[var(--km-fg-muted)]">暂无结算记录</p>
          ) : null}
        </div>
      </section>

      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold">我的卡密</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            这里只显示通过你的店铺已经售出的卡密。
          </p>
        </div>
        <div className="space-y-3">
          {cdks.map((cdk) => (
            <div
              key={cdk.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--km-border)] p-4"
            >
              <div>
                <p className="font-mono text-sm">{cdk.code}</p>
                <p className="mt-1 text-xs text-[var(--km-fg-muted)]">
                  {cdk.planKey} · {cdk.orderNo} · {cdk.status}
                </p>
              </div>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                onClick={() => revealCdk(cdk.id)}
              >
                显示完整卡密
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
