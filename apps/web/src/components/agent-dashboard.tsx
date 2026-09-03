"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApplyTheme } from "@/components/apply-theme";
import { toast } from "@/components/toast";
import { centsFromYuanText, yuanTextFromCents } from "@/lib/money";
import { publicStatusLabel } from "@/lib/status-labels";
import { THEME_CHOICES } from "@/lib/themes";
import type { ThemeId } from "@kaimi/themes";

type AgentProfile = {
  username: string;
  displayName: string;
  currentSlug: string;
  themeId: ThemeId;
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
  const [themeId, setThemeId] = useState<ThemeId>(initialProfile.themeId);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [plans, setPlans] = useState<AgentPlan[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [cdks, setCdks] = useState<AgentCdk[]>([]);
  const [cdkPage, setCdkPage] = useState(1);
  const [cdkPageSize] = useState(10);
  const [cdkTotal, setCdkTotal] = useState(0);
  const [cdkQ, setCdkQ] = useState("");
  const [cdkQuery, setCdkQuery] = useState("");
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [settlements, setSettlements] = useState<AgentSettlement[]>([]);
  const [earningRange, setEarningRange] = useState("7d");
  const [origin, setOrigin] = useState("");

  /** 卡密列表只带套餐码（plus / pro_5x），代理认的是套餐名。 */
  function planName(planKey: string) {
    return plans.find((plan) => plan.planKey === planKey)?.name || planKey;
  }

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

  async function loadCdks(page = cdkPage, query = cdkQuery) {
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: String(cdkPageSize),
    });
    if (query.trim()) qs.set("q", query.trim());
    const response = await fetch(`/api/agent/cdks?${qs}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "卡密加载失败");
    setCdks(data.list || []);
    setCdkTotal(Number(data.total) || 0);
    setCdkPage(Number(data.page) || page);
  }

  async function loadSales() {
    const range = earningQuery();
    const [earningsResponse, settlementResponse] = await Promise.all([
      fetch(`/api/agent/earnings?pageSize=20${range}`, { cache: "no-store" }),
      fetch("/api/agent/settlements", { cache: "no-store" }),
    ]);
    const [earningsData, settlementData] = await Promise.all([
      earningsResponse.json(),
      settlementResponse.json(),
    ]);
    if (!earningsResponse.ok) {
      throw new Error(earningsData.error || "收益加载失败");
    }
    if (!settlementResponse.ok) {
      throw new Error(settlementData.error || "结算记录加载失败");
    }
    setEarnings(earningsData);
    setSettlements(settlementData.list || []);
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    void Promise.all([loadPlans(), loadSales()]).catch((reason) => {
      setMessage(reason instanceof Error ? reason.message : "套餐加载失败");
    });
    // loadPlans/loadSales close over current earningRange
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earningRange]);

  useEffect(() => {
    void loadCdks(cdkPage).catch((reason) => {
      setMessage(reason instanceof Error ? reason.message : "卡密加载失败");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdkPage, cdkQuery]);

  async function saveShop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/agent/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, themeId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setSlug(data.slug);
      setSavedSlug(data.slug);
      setThemeId(data.themeId || themeId);
      toast("店铺设置已保存");
      router.refresh();
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
    <div data-theme={themeId} className="space-y-6">
      <ApplyTheme themeId={themeId} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="km-page-title">{initialProfile.displayName}</h1>
          <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
            登录账号 {initialProfile.username}。客户从你的店铺下单，零售价在下面改。第一次用先看
            <a className="mx-1 underline" href="/agent/guide">
              使用说明
            </a>
            。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="km-btn" href={`/s/${savedSlug}`} target="_blank" rel="noreferrer">
            打开店铺
          </a>
          <a className="km-btn km-btn-ghost" href="/agent/guide">
            使用说明
          </a>
          <button type="button" className="km-btn km-btn-ghost" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>

      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold">店铺外观与链接</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            点选主题可立即预览。记得点「保存店铺设置」，店铺页才会记住。改 slug 后，旧链接会跳到新链接。
          </p>
        </div>
        <form onSubmit={saveShop} className="space-y-4">
          <div className="space-y-2">
            <span className="text-sm">店铺主题</span>
            <div className="km-theme-grid">
              {THEME_CHOICES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  data-theme={theme.id}
                  className="km-theme-swatch"
                  aria-pressed={themeId === theme.id}
                  onClick={() => setThemeId(theme.id)}
                >
                  <span className="block font-medium">{theme.label}</span>
                  <span className="mt-1 block text-xs text-[var(--km-fg-muted)]">
                    {theme.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>
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
          <div className="flex flex-wrap items-center gap-3">
            <a
              className="break-all text-sm underline"
              href={`/s/${savedSlug}`}
              target="_blank"
              rel="noreferrer"
            >
              {origin ? `${origin}/s/${savedSlug}` : `/s/${savedSlug}`}
            </a>
            <a className="km-btn km-btn-ghost" href={`/s/${savedSlug}`} target="_blank" rel="noreferrer">
              打开店铺
            </a>
          </div>
          {message ? <p className="text-sm">{message}</p> : null}
          <button className="km-btn km-btn-primary" disabled={busy}>
            {busy ? "保存中…" : "保存店铺设置"}
          </button>
        </form>
      </section>

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
                          : "平台暂时缺货"}
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
                className={earningRange === value ? "km-btn" : "km-btn km-btn-ghost"}
                disabled={busy}
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
                    <th className="py-2">手续费口径</th>
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
                      <td className="py-2">
                        {publicStatusLabel(item.feeReconcileStatus, "fee")}
                      </td>
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
                <p className="text-[var(--km-fg-muted)]">
                  {publicStatusLabel(settlement.status, "settlement")}
                </p>
              </div>
            </div>
          ))}
          {!settlements.length ? (
            <p className="text-sm text-[var(--km-fg-muted)]">暂无结算记录</p>
          ) : null}
        </div>
      </section>

      <section className="km-panel space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">我的卡密</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              只显示你店铺已售出的卡密，每页 {cdkPageSize} 条。
            </p>
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setCdkPage(1);
              setCdkQuery(cdkQ.trim());
            }}
          >
            <input
              className="km-input w-56"
              value={cdkQ}
              onChange={(event) => setCdkQ(event.target.value)}
              placeholder="按订单号筛选"
            />
            <button type="submit" className="km-btn km-btn-ghost">
              筛选
            </button>
          </form>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">卡密</th>
                <th className="py-2 pr-3">套餐</th>
                <th className="py-2 pr-3">订单</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {cdks.map((cdk) => (
                <tr key={cdk.id} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3 font-mono text-xs">{cdk.code}</td>
                  <td className="py-2 pr-3">{planName(cdk.planKey)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{cdk.orderNo}</td>
                  <td className="py-2 pr-3">
                    {publicStatusLabel(cdk.status, "cdk")}
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      className="km-btn km-btn-ghost"
                      onClick={() => revealCdk(cdk.id)}
                    >
                      显示完整卡密
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!cdks.length ? (
            <p className="py-8 text-center text-sm text-[var(--km-fg-muted)]">
              {cdkQuery ? "没有匹配的卡密" : "还没有售出卡密"}
            </p>
          ) : null}
        </div>
        {cdkTotal > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--km-border)] pt-3 text-sm">
            <span className="text-[var(--km-fg-muted)]">
              共 {cdkTotal} 条，第 {cdkPage} / {Math.max(1, Math.ceil(cdkTotal / cdkPageSize))} 页
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={cdkPage <= 1}
                onClick={() => setCdkPage((page) => Math.max(1, page - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={cdkPage * cdkPageSize >= cdkTotal}
                onClick={() => setCdkPage((page) => page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
