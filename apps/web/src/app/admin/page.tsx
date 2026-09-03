"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AdminAgents } from "@/components/admin-agents";
import { useAskDialog } from "@/components/ask-dialog";
import { AdminGuide } from "@/components/admin-guide";
import { CardIntegration } from "@/components/card-integration";
import { CardSelectionConfig } from "@/components/card-selection-config";
import { CommerceAdmin } from "@/components/commerce-admin";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { THEME_CHOICES } from "@/lib/themes";

type Tab =
  | "overview"
  | "orders"
  | "cdks"
  | "integration"
  | "selection"
  | "commerce"
  | "agents"
  | "appearance"
  | "guide";

type Overview = {
  setupCompleted: boolean;
  paymentMode: string;
  hasCardplatform?: boolean;
  cardplatformSiteBase?: string;
  unusedStock: number;
  lockedCount?: number;
  inflightCount?: number;
  orderCount: number;
  stock: Record<string, number>;
  recentOrders: Array<Record<string, string>>;
};

type Integration = {
  publicBaseUrl: string;
  paymentMode: string;
  hasCardplatform?: boolean;
  cardplatformSiteBase?: string;
  notifyWebhookUrl?: string;
  telegramBotTokenHint?: string;
  telegramBotTokenConfigured?: boolean;
  telegramChatId?: string;
};

const STATUS_LABEL: Record<string, string> = {
  unused: "未使用",
  locked: "占用中",
  sold: "已售出",
  used: "已核销",
  disabled: "已禁用",
  pending: "排队中",
  processing: "处理中",
  success: "成功",
  failed: "失败",
  unknown: "未知",
  fulfilled: "已完成",
  paid: "已支付",
  unpaid: "未支付",
  pending_pay: "待支付",
  delivered: "已发货",
  paid_undelivered: "已付未发",
  issuing: "发货中",
  expired: "已过期",
  cancelled: "已取消",
  manual: "已持码",
  skipped: "已跳过",
};

const KIND_LABEL: Record<string, string> = {
  recharge: "兑换",
  shop: "发卡",
  code: "发卡",
  purchase: "进货",
};

const HASH_TABS: Tab[] = [
  "overview",
  "orders",
  "cdks",
  "integration",
  "selection",
  "commerce",
  "agents",
  "appearance",
  "guide",
];

function tabFromHash(hash: string): Tab | null {
  if (hash === "card-selection") return "selection";
  return HASH_TABS.includes(hash as Tab) ? (hash as Tab) : null;
}

function kindLabel(kind: unknown) {
  const key = String(kind || "");
  return KIND_LABEL[key] || key || "—";
}

function formatWhen(value: unknown) {
  const raw = String(value || "");
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function AdminPage() {
  const [boot, setBoot] = useState<{ admin: { username: string } | null } | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [cdks, setCdks] = useState<Array<Record<string, unknown>>>([]);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [storefronts, setStorefronts] = useState<Array<Record<string, unknown>>>([]);
  const [siteTheme, setSiteTheme] = useState("snow");
  const [siteName, setSiteName] = useState("Kaimi");
  const [shopEnabled, setShopEnabled] = useState(false);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState("");
  const [loginForm, setLoginForm] = useState({ username: "admin", password: "" });
  const [orderQ, setOrderQ] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [cdkQ, setCdkQ] = useState("");
  const [cdkStatus, setCdkStatus] = useState("");
  const [cdkPage, setCdkPage] = useState(1);
  const [cdkPageSize] = useState(20);
  const [cdkTotal, setCdkTotal] = useState(0);
  const { ask, dialog } = useAskDialog();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [integForm, setIntegForm] = useState({
    publicBaseUrl: "",
    notifyWebhookUrl: "",
    telegramBotToken: "",
    telegramChatId: "",
  });
  const [busy, setBusy] = useState(false);

  function goTab(next: Tab) {
    setTab(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${next}`);
    }
  }

  async function refreshBoot() {
    const res = await fetch("/api/setup");
    setBoot(await res.json());
  }

  async function loadSection(section: string, extra = "") {
    const res = await fetch(`/api/admin?section=${section}${extra}`);
    if (res.status === 401) {
      setBoot((b) => (b ? { ...b, admin: null } : b));
      return null;
    }
    return res.json();
  }

  useEffect(() => {
    void refreshBoot();
    function applyLocation() {
      const queryTab = new URLSearchParams(window.location.search).get("tab");
      const next =
        tabFromHash(queryTab || "") ||
        tabFromHash(window.location.hash.replace("#", ""));
      if (next) setTab(next);
    }
    applyLocation();
    window.addEventListener("hashchange", applyLocation);
    return () => window.removeEventListener("hashchange", applyLocation);
  }, []);

  useEffect(() => {
    if (!boot?.admin) return;
    void (async () => {
      setMsg("");
      if (tab === "overview") setOverview(await loadSection("overview"));
      if (tab === "orders") {
        const qs = new URLSearchParams();
        if (orderQ) qs.set("q", orderQ);
        if (orderStatus) qs.set("status", orderStatus);
        const data = await loadSection("orders", `&${qs}`);
        setOrders(data?.list || []);
      }
      if (tab === "cdks") {
        const qs = new URLSearchParams();
        if (cdkQ) qs.set("q", cdkQ);
        if (cdkStatus) qs.set("status", cdkStatus);
        qs.set("page", String(cdkPage));
        qs.set("page_size", String(cdkPageSize));
        const data = await loadSection("stock", `&${qs}`);
        setCdks(data?.list || []);
        setCdkTotal(Number(data?.total) || 0);
      }
      if (tab === "integration") {
        const data = (await loadSection("integration")) as Integration | null;
        setIntegration(data);
        if (data) {
          setIntegForm({
            publicBaseUrl: data.publicBaseUrl || "",
            notifyWebhookUrl: data.notifyWebhookUrl || "",
            telegramBotToken: "",
            telegramChatId: data.telegramChatId || "",
          });
        }
      }
      if (tab === "appearance") {
        const data = await loadSection("appearance");
        setStorefronts(data?.list || []);
        setSiteTheme(data?.siteTheme || "snow");
        setSiteName(data?.siteName || "Kaimi");
        setShopEnabled(Boolean(data?.shopEnabled));
      }
    })();
    // order/cdk filters are applied via explicit 筛选 buttons
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot?.admin, tab, cdkPage]);

  const tabs = useMemo(
    () =>
      [
        ["overview", "总览"],
        ["orders", "订单查询"],
        ["cdks", "卡密查询"],
        ["integration", "接入卡台"],
        ["selection", "选卡配置"],
        ["commerce", "即时发卡"],
        ["agents", "代理管理"],
        ["appearance", "外观"],
        ["guide", "使用说明"],
      ] as const,
    [],
  );

  async function login() {
    setMsg("");
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", ...loginForm }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "登录失败", "err");
      setMsg(data.error || "登录失败");
      return;
    }
    await refreshBoot();
  }

  async function logout() {
    await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    await refreshBoot();
  }

  async function postAction(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        toast(data.error || data.message || "操作失败", "err");
        return data;
      }
      toast(data.message || "已完成");
      return data;
    } finally {
      setBusy(false);
    }
  }

  async function saveIntegration() {
    await postAction({ action: "save_integration", ...integForm });
    setIntegration(await loadSection("integration"));
  }

  async function refreshCdks(page = cdkPage) {
    const qs = new URLSearchParams();
    if (cdkQ) qs.set("q", cdkQ);
    if (cdkStatus) qs.set("status", cdkStatus);
    qs.set("page", String(page));
    qs.set("page_size", String(cdkPageSize));
    const data = await loadSection("stock", `&${qs}`);
    setCdks(data?.list || []);
    setCdkTotal(Number(data?.total) || 0);
    setCdkPage(Number(data?.page) || page);
  }

  async function copyCdkCode(id: number, code: string) {
    try {
      await copyText(code);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  async function cdkOp(action: "void_cdk" | "disable_cdk" | "enable_cdk", id: number) {
    const label =
      action === "void_cdk" ? "核销" : action === "disable_cdk" ? "禁用" : "启用";
    const ok = await ask({
      title: `确认${label}该卡密？`,
      confirmLabel: label,
      danger: action !== "enable_cdk",
    });
    if (!ok) return;
    await postAction({ action, id });
    await refreshCdks();
  }

  async function saveAppearance() {
    await postAction({
      action: "save_appearance",
      siteTheme,
      siteName,
      shopEnabled,
    });
    const data = await loadSection("appearance");
    setStorefronts(data?.list || []);
    setSiteTheme(data?.siteTheme || siteTheme);
    setSiteName(data?.siteName || siteName);
    setShopEnabled(Boolean(data?.shopEnabled));
    toast("整站外观已保存");
  }

  async function revealCdk(id: number) {
    const data = await postAction({ action: "reveal_cdk", id });
    if (data?.code) {
      setRevealed((prev) => ({ ...prev, [id]: String(data.code) }));
    }
  }

  if (!boot) {
    return (
      <main className="km-shell-narrow py-20">
        <div className="km-panel">加载中…</div>
      </main>
    );
  }

  if (!boot.admin) {
    return (
      <main className="min-h-screen">
        <section className="km-shell-narrow space-y-6 py-20">
          <div className="km-page-hero km-rise">
            <h1 className="km-page-title">Kaimi 后台</h1>
            <p className="km-lead">管理员从这里登录。代理请走右上角「代理登录」。</p>
          </div>
          <div className="km-panel km-form-stack km-rise">
            <input
              className="km-input"
              value={loginForm.username}
              onChange={(e) => setLoginForm((s) => ({ ...s, username: e.target.value }))}
              placeholder="用户名"
            />
            <input
              className="km-input"
              type="password"
              value={loginForm.password}
              onChange={(e) => setLoginForm((s) => ({ ...s, password: e.target.value }))}
              placeholder="密码"
              onKeyDown={(e) => {
                if (e.key === "Enter") void login();
              }}
            />
            {msg ? <p className="text-sm text-[var(--km-danger)]">{msg}</p> : null}
            <button className="km-btn w-full" onClick={login}>
              登录
            </button>
            <Link href="/" className="text-center text-sm text-[var(--km-fg-muted)] underline">
              返回首页
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="km-admin min-h-screen">
      {dialog}
      <header className="km-header">
        <div className="km-shell-wide space-y-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="km-brand">
              <span className="km-brand-mark" aria-hidden>
                A
              </span>
              <div className="min-w-0">
                <div className="km-brand-name">Kaimi Admin</div>
                <p className="text-xs text-[var(--km-fg-muted)]">{boot.admin.username}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Link href="/" className="km-btn km-btn-ghost">
                前台
              </Link>
              <Link href="/login" className="km-btn km-btn-ghost">
                代理登录
              </Link>
              <button className="km-btn km-btn-ghost" onClick={logout}>
                退出
              </button>
            </div>
          </div>
          <nav className="km-tabs" aria-label="后台分区">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                className={`km-tab ${tab === id ? "km-tab-active" : ""}`}
                onClick={() => goTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <section className="km-shell-wide space-y-4 py-6 pb-16">
        {tab === "overview" && overview ? (
          <div className="space-y-4">
            {(overview.lockedCount || 0) > 0 || (overview.inflightCount || 0) > 0 ? (
              <div className="km-panel border-[var(--km-danger)]/40 text-sm">
                {(overview.lockedCount || 0) > 0 ? (
                  <p>
                    有 <strong>{overview.lockedCount}</strong> 张卡密占用中（locked）。若订单已失败仍锁着，请到「订单」点「修复卡住的锁」。
                  </p>
                ) : null}
                {(overview.inflightCount || 0) > 0 ? (
                  <p className="mt-1">
                    有 <strong>{overview.inflightCount}</strong> 笔开通未结束。服务端每分钟会轮询卡台；也可到订单页手动重拉。
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="km-btn km-btn-ghost text-sm"
                    disabled={busy}
                    onClick={async () => {
                      await postAction({ action: "reconcile_locks" });
                      setOverview(await loadSection("overview"));
                    }}
                  >
                    修复卡住的锁
                  </button>
                  <button
                    className="km-btn km-btn-ghost text-sm"
                    disabled={busy}
                    onClick={async () => {
                      await postAction({ action: "poll_inflight" });
                      setOverview(await loadSection("overview"));
                    }}
                  >
                    立即轮询进行中订单
                  </button>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-[var(--km-fg-muted)]">
                第一次开店或客户问流程，看「使用说明」。代理登录入口在右上角，零售价由代理自己改。
              </p>
              <button className="km-btn km-btn-ghost" onClick={() => goTab("guide")}>
                使用说明
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="可用卡密" value={String(overview.unusedStock)} />
              <StatCard label="订单总数" value={String(overview.orderCount)} />
              <StatCard label="已核销" value={String(overview.stock?.used ?? 0)} />
              <StatCard
                label="卡台接入"
                value={overview.hasCardplatform ? "已配置" : "未配置"}
                hint={overview.cardplatformSiteBase || "去「接入卡台」填写"}
              />
            </div>
            <div className="km-panel">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {(["unused", "locked", "sold", "used", "disabled"] as const).map((s) => (
                  <div key={s} className="text-center">
                    <div className="text-xs text-[var(--km-fg-muted)]">{STATUS_LABEL[s]}</div>
                    <div className="km-stat-value mt-1 !text-2xl">{overview.stock?.[s] ?? 0}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="km-panel overflow-x-auto">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold">最近订单</h3>
                <button className="km-btn km-btn-ghost" onClick={() => goTab("orders")}>
                  全部订单
                </button>
              </div>
              <table className="km-table text-sm">
                <colgroup>
                  <col style={{ width: "46%" }} />
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "32%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>订单</th>
                    <th>类型</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recentOrders.map((o) => (
                    <tr key={o.orderNo}>
                      <td className="km-clip font-mono" title={o.orderNo}>
                        {o.orderNo}
                      </td>
                      <td>{kindLabel(o.kind)}</td>
                      <td>
                        <StatusBadge status={o.fulfillStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!overview.recentOrders.length ? <p className="py-4 text-sm text-[var(--km-fg-muted)]">暂无订单</p> : null}
            </div>
          </div>
        ) : null}

        {tab === "orders" ? (
          <div className="km-panel overflow-x-auto text-sm">
            <div className="km-toolbar">
              <input
                className="km-input max-w-xs"
                placeholder="订单号 / 邮箱 / 卡密后四位"
                value={orderQ}
                onChange={(e) => setOrderQ(e.target.value)}
              />
              <select className="km-input max-w-[10rem]" value={orderStatus} onChange={(e) => setOrderStatus(e.target.value)}>
                <option value="">全部状态</option>
                {(
                  [
                    "pending",
                    "processing",
                    "success",
                    "failed",
                    "unknown",
                    "fulfilled",
                    "paid",
                    "unpaid",
                    "pending_pay",
                    "paid_undelivered",
                    "issuing",
                  ] as const
                ).map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABEL[value] || value}
                  </option>
                ))}
              </select>
              <button
                className="km-btn"
                onClick={async () => {
                  const qs = new URLSearchParams();
                  if (orderQ) qs.set("q", orderQ);
                  if (orderStatus) qs.set("status", orderStatus);
                  const data = await loadSection("orders", `&${qs}`);
                  setOrders(data?.list || []);
                }}
              >
                筛选
              </button>
              <button
                className="km-btn km-btn-ghost"
                disabled={busy}
                onClick={async () => {
                  await postAction({ action: "poll_inflight" });
                  const qs = new URLSearchParams();
                  if (orderQ) qs.set("q", orderQ);
                  if (orderStatus) qs.set("status", orderStatus);
                  const data = await loadSection("orders", `&${qs}`);
                  setOrders(data?.list || []);
                }}
              >
                轮询进行中
              </button>
              <button
                className="km-btn km-btn-ghost"
                disabled={busy}
                onClick={async () => {
                  const data = await postAction({ action: "reconcile_locks" });
                  if (data?.ok) {
                    toast(`已修复锁：释放 ${data.released ?? 0}，核销 ${data.used ?? 0}`);
                  }
                }}
              >
                修复卡住的锁
              </button>
              <a
                className="km-btn km-btn-ghost"
                href={`/api/admin?section=orders&export=csv${orderQ ? `&q=${encodeURIComponent(orderQ)}` : ""}${orderStatus ? `&status=${encodeURIComponent(orderStatus)}` : ""}`}
              >
                导出 CSV
              </a>
            </div>
            <table className="km-table">
              <colgroup>
                <col style={{ width: "18%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "9%" }} />
                <col style={{ width: "9%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "8%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>订单</th>
                  <th>类型</th>
                  <th>邮箱</th>
                  <th>卡密</th>
                  <th>套餐</th>
                  <th>支付</th>
                  <th>履约</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const orderNo = String(o.orderNo || "");
                  const email = String(o.email || o.accountEmail || "—");
                  const code = String(o.codeMasked || o.codeLast4 || "—");
                  const plan = String(o.upstreamPlan || "—");
                  const message = o.message ? String(o.message) : "";
                  return (
                    <tr key={String(o.id)}>
                      <td className="km-clip font-mono" title={orderNo}>
                        {orderNo}
                      </td>
                      <td>{kindLabel(o.kind)}</td>
                      <td className="km-clip" title={email}>
                        {email}
                      </td>
                      <td className="km-clip font-mono" title={code}>
                        {code}
                      </td>
                      <td className="km-clip" title={plan}>
                        {plan}
                      </td>
                      <td>
                        <StatusBadge status={String(o.payStatus || "")} />
                      </td>
                      <td>
                        <span title={message || undefined}>
                          <StatusBadge status={String(o.fulfillStatus || "")} />
                        </span>
                      </td>
                      <td className="km-clip text-[var(--km-fg-muted)]" title={String(o.createdAt || "")}>
                        {formatWhen(o.createdAt)}
                      </td>
                      <td>
                        {o.kind === "recharge" && o.upstreamRequestId ? (
                          <button
                            className="km-btn km-btn-ghost"
                            disabled={busy}
                            onClick={async () => {
                              await postAction({
                                action: "poll_order",
                                orderNo: o.orderNo,
                                requestId: o.upstreamRequestId,
                              });
                              const qs = new URLSearchParams();
                              if (orderQ) qs.set("q", orderQ);
                              if (orderStatus) qs.set("status", orderStatus);
                              const data = await loadSection("orders", `&${qs}`);
                              setOrders(data?.list || []);
                            }}
                          >
                            重拉
                          </button>
                        ) : (
                          <span className="text-[var(--km-fg-muted)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!orders.length ? <p className="py-4 text-[var(--km-fg-muted)]">无匹配订单</p> : null}
          </div>
        ) : null}

        {tab === "cdks" ? (
          <div className="km-panel overflow-x-auto text-sm">
            <div className="km-toolbar">
              <input
                className="km-input max-w-xs font-mono"
                placeholder="订单号 / 完整卡密 / 套餐"
                value={cdkQ}
                onChange={(e) => setCdkQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setCdkPage(1);
                    void refreshCdks(1);
                  }
                }}
              />
              <select
                className="km-input max-w-[10rem]"
                value={cdkStatus}
                onChange={(e) => {
                  const next = e.target.value;
                  setCdkStatus(next);
                  setCdkPage(1);
                  void (async () => {
                    const qs = new URLSearchParams();
                    if (cdkQ) qs.set("q", cdkQ);
                    if (next) qs.set("status", next);
                    qs.set("page", "1");
                    qs.set("page_size", String(cdkPageSize));
                    const data = await loadSection("stock", `&${qs}`);
                    setCdks(data?.list || []);
                    setCdkTotal(Number(data?.total) || 0);
                  })();
                }}
              >
                <option value="">全部状态</option>
                <option value="unused">未使用</option>
                <option value="used">已核销</option>
                <option value="disabled">已禁用</option>
              </select>
              <button
                className="km-btn"
                onClick={() => {
                  setCdkPage(1);
                  void refreshCdks(1);
                }}
              >
                筛选
              </button>
              <span className="ml-auto text-xs text-[var(--km-fg-muted)]">
                共 {cdkTotal} 条店铺已售卡密 · 默认脱敏，点「显示」后再复制
              </span>
            </div>

            <table className="km-table">
              <colgroup>
                <col style={{ width: "28%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>卡密</th>
                  <th>状态</th>
                  <th>套餐</th>
                  <th>订单</th>
                  <th>代理</th>
                  <th>更新</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {cdks.map((c) => {
                  const status = String(c.status);
                  const id = Number(c.id);
                  const code = revealed[id] || "";
                  const display = code || String(c.codeMasked || "");
                  return (
                    <tr key={String(c.id)}>
                      <td>
                        <div className="flex min-w-0 items-center gap-2">
                          <code className="km-clip font-mono text-sm tracking-wide" title={display}>
                            {display}
                          </code>
                          {code ? (
                            <button
                              type="button"
                              className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--km-fg-muted)] hover:underline"
                              onClick={() => void copyCdkCode(id, code)}
                            >
                              {copiedId === id ? "已复制" : "复制"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--km-fg-muted)] hover:underline"
                              onClick={() => void revealCdk(id)}
                            >
                              显示
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={status} />
                      </td>
                      <td className="km-clip font-mono" title={String(c.planKey || "")}>
                        {String(c.planKey || "—")}
                      </td>
                      <td className="km-clip font-mono text-xs" title={String(c.orderNo || "")}>
                        {String(c.orderNo || "—")}
                      </td>
                      <td className="km-clip" title={String(c.agentName || "")}>
                        {String(c.agentName || "—")}
                      </td>
                      <td className="km-clip text-[var(--km-fg-muted)]" title={String(c.updatedAt || "")}>
                        {formatWhen(c.updatedAt)}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          {status !== "used" && status !== "disabled" && status !== "locked" ? (
                            <button className="km-btn km-btn-ghost" onClick={() => void cdkOp("void_cdk", id)}>
                              核销
                            </button>
                          ) : null}
                          {status === "unused" || status === "sold" ? (
                            <button
                              className="km-btn km-btn-ghost text-[var(--km-danger)]"
                              onClick={() => void cdkOp("disable_cdk", id)}
                            >
                              禁用
                            </button>
                          ) : null}
                          {status === "disabled" ? (
                            <button
                              className="km-btn km-btn-ghost text-[var(--km-success)]"
                              onClick={() => void cdkOp("enable_cdk", id)}
                            >
                              启用
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!cdks.length ? (
              <p className="py-8 text-center text-[var(--km-fg-muted)]">还没有店铺售出的卡密</p>
            ) : null}

            {cdkTotal > 0 ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--km-border)] pt-3">
                <span className="text-[var(--km-fg-muted)]">
                  第 {cdkPage} / {Math.max(1, Math.ceil(cdkTotal / cdkPageSize))} 页
                </span>
                <div className="flex gap-2">
                  <button
                    className="km-btn km-btn-ghost"
                    disabled={cdkPage <= 1}
                    onClick={() => setCdkPage((p) => Math.max(1, p - 1))}
                  >
                    上一页
                  </button>
                  <button
                    className="km-btn km-btn-ghost"
                    disabled={cdkPage * cdkPageSize >= cdkTotal}
                    onClick={() => setCdkPage((p) => p + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "integration" && integration ? (
          <div className="space-y-4">
            <CardIntegration publicBaseUrl={integForm.publicBaseUrl} />

            <div className="km-panel space-y-4">
              <div>
                <h2 className="text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
                  站点通知
                </h2>
                <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
                  兑换开通到终态时，可选推送到 Webhook 或 Telegram。和卡台接入无关。
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  <span>本站公网地址</span>
                  <input
                    className="km-input"
                    placeholder="https://kaimi.example.com"
                    value={integForm.publicBaseUrl}
                    onChange={(e) => setIntegForm((s) => ({ ...s, publicBaseUrl: e.target.value }))}
                  />
                  <span className="text-xs text-[var(--km-fg-muted)]">
                    给易支付和卡台回调用，不能填 localhost。即时发卡页也会改同一项。
                  </span>
                </label>
                <label className="block space-y-1 text-sm">
                  <span>终态通知地址（可选）</span>
                  <input
                    className="km-input"
                    placeholder="https://example.com/notify"
                    value={integForm.notifyWebhookUrl}
                    onChange={(e) => setIntegForm((s) => ({ ...s, notifyWebhookUrl: e.target.value }))}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Telegram Token（可选）</span>
                  <input
                    className="km-input font-mono"
                    type="password"
                    placeholder={integration.telegramBotTokenConfigured ? "留空则不修改" : "123456:ABC…"}
                    value={integForm.telegramBotToken}
                    onChange={(e) => setIntegForm((s) => ({ ...s, telegramBotToken: e.target.value }))}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Telegram Chat ID</span>
                  <input
                    className="km-input"
                    placeholder="-100…"
                    value={integForm.telegramChatId}
                    onChange={(e) => setIntegForm((s) => ({ ...s, telegramChatId: e.target.value }))}
                  />
                </label>
              </div>
              <button className="km-btn" disabled={busy} onClick={() => void saveIntegration()}>
                保存通知设置
              </button>
            </div>
          </div>
        ) : null}

        {tab === "selection" ? <CardSelectionConfig /> : null}

        {tab === "commerce" ? <CommerceAdmin embedded /> : null}

        {tab === "agents" ? <AdminAgents /> : null}

        {tab === "appearance" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="km-panel space-y-3 lg:col-span-2">
              <div>
                <h3 className="font-semibold">整站外观</h3>
                <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
                  站点名和主题会应用到全部前台页面。代理店铺可以各自选主题，不受这里影响。
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  <span>站点名</span>
                  <input className="km-input" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="如 Kaimi" />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>主题</span>
                  <select className="km-input" value={siteTheme} onChange={(e) => setSiteTheme(e.target.value)}>
                    {THEME_CHOICES.map((theme) => (
                      <option key={theme.id} value={theme.id}>
                        {theme.label} / {theme.hint}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={shopEnabled} onChange={(e) => setShopEnabled(e.target.checked)} />
                  <span>开启内部发卡页（仅调试）</span>
                </label>
                <button className="km-btn" onClick={() => void saveAppearance()}>
                  保存整站设置
                </button>
              </div>
            </div>
            {storefronts.map((sf) => (
              <StorefrontCard
                key={String(sf.id)}
                sf={sf}
                onSave={async (next) => {
                  await postAction({
                    action: "save_storefront",
                    id: next.id,
                    storefrontName: next.siteName,
                    themeId: next.themeId,
                    announcement: next.announcement,
                    afterSales: next.afterSales,
                    enabled: next.enabled,
                  });
                  const data = await loadSection("appearance");
                  setStorefronts(data?.list || []);
                  toast("页面文案已保存");
                }}
              />
            ))}
          </div>
        ) : null}

        {tab === "guide" ? <AdminGuide onGo={goTab} /> : null}
      </section>
    </main>
  );
}

function statusTone(status: string) {
  const s = status.toLowerCase();
  if (["success", "fulfilled", "unused", "used", "paid", "ok"].includes(s)) return "ok";
  if (["failed", "unknown", "disabled", "error"].includes(s)) return "bad";
  if (["pending", "processing", "locked", "sold", "unpaid"].includes(s)) return "wait";
  return "";
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status);
  return <span className={`km-badge ${tone ? `km-badge-${tone}` : ""}`}>{STATUS_LABEL[status] || status || "—"}</span>;
}

function StatCard(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="km-stat">
      <p className="text-xs text-[var(--km-fg-muted)]">{props.label}</p>
      <p className="km-stat-value">{props.value}</p>
      {props.hint ? <p className="mt-1 truncate text-xs text-[var(--km-fg-muted)]">{props.hint}</p> : null}
    </div>
  );
}

function StorefrontCard({
  sf,
  onSave,
}: {
  sf: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    id: Number(sf.id),
    siteName: String(sf.siteName || ""),
    themeId: String(sf.themeId || "snow"),
    announcement: String(sf.announcement || ""),
    afterSales: String(sf.afterSales || ""),
    enabled: Boolean(sf.enabled ?? true),
  });

  const title = String(sf.kind) === "shop" ? "发卡页文案" : String(sf.kind) === "recharge" ? "兑换页文案" : "页面文案";

  return (
    <div className="km-panel space-y-3">
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs text-[var(--km-fg-muted)]">只改这一页的标题和说明，整站主题用上面保存。</p>
      </div>
      <label className="block space-y-1 text-sm">
        <span>页面标题</span>
        <input
          className="km-input"
          value={form.siteName}
          onChange={(e) => setForm((s) => ({ ...s, siteName: e.target.value }))}
          placeholder="页面标题"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>公告</span>
        <textarea
          className="km-input min-h-20"
          value={form.announcement}
          onChange={(e) => setForm((s) => ({ ...s, announcement: e.target.value }))}
          placeholder="显示在页面标题下方"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>页脚说明</span>
        <textarea
          className="km-input min-h-16"
          value={form.afterSales}
          onChange={(e) => setForm((s) => ({ ...s, afterSales: e.target.value }))}
          placeholder="售后或注意事项"
        />
      </label>
      <button className="km-btn" onClick={() => void onSave(form)}>
        保存文案
      </button>
    </div>
  );
}
