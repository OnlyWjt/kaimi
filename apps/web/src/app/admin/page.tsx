"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AdminGuide } from "@/components/admin-guide";

type Tab = "overview" | "orders" | "cdks" | "purchase" | "integration" | "appearance" | "guide";

type Overview = {
  setupCompleted: boolean;
  paymentMode: string;
  upstreamBaseUrl: string;
  hasUpstreamKey: boolean;
  hasWebhookSecret: boolean;
  unusedStock: number;
  lockedCount?: number;
  inflightCount?: number;
  orderCount: number;
  stock: Record<string, number>;
  recentOrders: Array<Record<string, string>>;
};

type Integration = {
  upstreamBaseUrl: string;
  apiKeyHint: string;
  apiKeyConfigured: boolean;
  webhookSecretHint: string;
  webhookSecretConfigured: boolean;
  publicBaseUrl: string;
  webhookCallbackUrl: string;
  agentApiBase: string;
  paymentMode: string;
  syncIntervalMinutes: number;
  syncLastAt: string;
  syncLastResult: string;
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
  const [buyCdkUrl, setBuyCdkUrl] = useState("");
  const [shopEnabled, setShopEnabled] = useState(false);
  const [purchaseOrders, setPurchaseOrders] = useState<Array<Record<string, unknown>>>([]);
  const [purchasePlans, setPurchasePlans] = useState<Array<{ key: string; name?: string; label?: string }>>([]);
  const [purchasePlan, setPurchasePlan] = useState("");
  const [purchaseCount, setPurchaseCount] = useState(1);
  const [purchasePayType, setPurchasePayType] = useState<"alipay" | "wxpay">("alipay");
  const [purchaseLastImport, setPurchaseLastImport] = useState<{
    at?: string;
    imported?: number;
    restored?: number;
    orders?: string[];
  } | null>(null);
  const [deliveries, setDeliveries] = useState<Array<Record<string, unknown>>>([]);
  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]);
  const [recordQ, setRecordQ] = useState("");
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
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [integForm, setIntegForm] = useState({
    upstreamBaseUrl: "",
    upstreamApiKey: "",
    webhookSecret: "",
    publicBaseUrl: "",
    paymentMode: "manual",
    syncIntervalMinutes: 15,
    notifyWebhookUrl: "",
    telegramBotToken: "",
    telegramChatId: "",
  });
  const [pingResult, setPingResult] = useState<{
    ok?: boolean;
    message?: string;
    plans?: Array<{ key: string; name?: string; price_yuan?: string }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);

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
            upstreamBaseUrl: data.upstreamBaseUrl || "",
            upstreamApiKey: "",
            webhookSecret: "",
            publicBaseUrl: data.publicBaseUrl || "",
            paymentMode: "manual",
            syncIntervalMinutes: data.syncIntervalMinutes ?? 15,
            notifyWebhookUrl: data.notifyWebhookUrl || "",
            telegramBotToken: "",
            telegramChatId: data.telegramChatId || "",
          });
          const deliveriesData = await loadSection("deliveries");
          setDeliveries(deliveriesData?.list || []);
          const recordsData = await loadSection("records");
          setRecords(recordsData?.list || []);
        }
      }
      if (tab === "purchase") {
        const data = await loadSection("purchase");
        setPurchaseOrders(data?.list || []);
        setPurchasePlans(data?.plans || []);
        setPurchaseLastImport(data?.lastImport || null);
        if (!purchasePlan && data?.plans?.[0]?.key) setPurchasePlan(String(data.plans[0].key));
      }
      if (tab === "appearance") {
        const data = await loadSection("appearance");
        setStorefronts(data?.list || []);
        setSiteTheme(data?.siteTheme || "snow");
        setSiteName(data?.siteName || "Kaimi");
        setBuyCdkUrl(data?.buyCdkUrl || "");
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
        ["purchase", "进货"],
        ["integration", "接入 danewcdk"],
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
    setMsg("");
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setMsg(data.error || data.message || "操作失败");
        return data;
      }
      setMsg(data.message || "已完成");
      return data;
    } finally {
      setBusy(false);
    }
  }

  async function saveIntegration() {
    await postAction({ action: "save_integration", ...integForm });
    setIntegration(await loadSection("integration"));
  }

  async function testConnection() {
    const data = await postAction({ action: "test_connection" });
    setPingResult(data);
  }

  async function syncStock() {
    const data = await postAction({ action: "sync_stock" });
    if (data?.ok) {
      setMsg(
        `同步完成：新增 ${data.imported ?? 0}，恢复 ${data.restored ?? 0}，收回禁用 ${data.disabled ?? 0}${
          data.incomplete ? "（列表过大，未完整对账）" : ""
        }`,
      );
    }
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
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      setMsg("复制失败，请手动选择");
    }
  }

  async function cdkOp(action: "void_cdk" | "disable_cdk" | "enable_cdk", id: number) {
    const label =
      action === "void_cdk" ? "核销" : action === "disable_cdk" ? "禁用" : "启用";
    if (!window.confirm(`确认${label}该卡密？`)) return;
    await postAction({ action, id });
    await refreshCdks();
  }

  async function saveAppearance() {
    await postAction({
      action: "save_appearance",
      siteTheme,
      siteName,
      buyCdkUrl,
      shopEnabled,
    });
    const data = await loadSection("appearance");
    setStorefronts(data?.list || []);
    setSiteTheme(data?.siteTheme || siteTheme);
    setSiteName(data?.siteName || siteName);
    setBuyCdkUrl(data?.buyCdkUrl || "");
    setShopEnabled(Boolean(data?.shopEnabled));
    setMsg("整站外观已保存");
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
            <p className="km-eyebrow">Admin</p>
            <h1 className="km-page-title">Kaimi 后台</h1>
            <p className="km-lead">登录后管理订单、卡密与上游接入。</p>
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
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <section className="km-shell-wide space-y-4 py-6 pb-16">
        {msg ? (
          <div className="km-stat text-sm">
            {msg}
          </div>
        ) : null}

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
                    有 <strong>{overview.inflightCount}</strong> 笔开通未结束。服务端每分钟会轮询主站；也可到订单页手动重拉。
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
              <p className="text-sm text-[var(--km-fg-muted)]">第一次开店或客户问流程，看「使用说明」。</p>
              <button className="km-btn km-btn-ghost" onClick={() => setTab("guide")}>
                使用说明
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="可用卡密" value={String(overview.unusedStock)} />
              <StatCard label="订单总数" value={String(overview.orderCount)} />
              <StatCard label="已核销" value={String(overview.stock?.used ?? 0)} />
              <StatCard
                label="上游接入"
                value={overview.hasUpstreamKey ? "已配置" : "未配置"}
                hint={overview.upstreamBaseUrl || "去「接入 danewcdk」填写"}
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
                <button className="km-btn km-btn-ghost" onClick={() => setTab("orders")}>
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
                <option value="pending">pending</option>
                <option value="processing">processing</option>
                <option value="success">success</option>
                <option value="failed">failed</option>
                <option value="unknown">unknown</option>
                <option value="fulfilled">fulfilled</option>
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
                  if (data?.ok) setMsg(`已修复锁：释放 ${data.released ?? 0}，核销 ${data.used ?? 0}`);
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
                placeholder="卡密片段"
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
                {Object.entries(STATUS_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
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
              <button
                className="km-btn km-btn-ghost"
                disabled={busy}
                onClick={async () => {
                  await syncStock();
                  await refreshCdks(1);
                }}
              >
                从 danewcdk 同步
              </button>
              <span className="ml-auto text-xs text-[var(--km-fg-muted)]">
                共 {cdkTotal} 条 · 默认脱敏，点「显示」后再复制
              </span>
            </div>

            <table className="km-table">
              <colgroup>
                <col style={{ width: "38%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "16%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>卡密</th>
                  <th>状态</th>
                  <th>套餐</th>
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
              <p className="py-8 text-center text-[var(--km-fg-muted)]">无卡密，请先接入并同步</p>
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

        {tab === "purchase" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
            <div className="km-panel space-y-3">
              <h3 className="font-semibold">向主站进货</h3>
              <p className="text-sm text-[var(--km-fg-muted)]">
                走 danewcdk Agent 下单（支付宝 / 微信）。付完后主站发码，本站每 30 秒拉已发货订单按单号入库。主站补上
                order.delivered 回调后会更快，拉单兜底会保留。
              </p>
              {purchaseLastImport?.at ? (
                <p className="text-xs text-[var(--km-fg-muted)]">
                  最近自动入库 {formatWhen(purchaseLastImport.at)}
                  {typeof purchaseLastImport.imported === "number"
                    ? ` · 新增 ${purchaseLastImport.imported}`
                    : ""}
                  {purchaseLastImport.restored ? ` · 恢复 ${purchaseLastImport.restored}` : ""}
                </p>
              ) : null}
              <label className="block space-y-1 text-sm">
                <span>套餐</span>
                <select className="km-input" value={purchasePlan} onChange={(e) => setPurchasePlan(e.target.value)}>
                  <option value="">选择套餐</option>
                  {purchasePlans.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label || p.name || p.key}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  <span>数量</span>
                  <input
                    className="km-input"
                    type="number"
                    min={1}
                    max={200}
                    value={purchaseCount}
                    onChange={(e) => setPurchaseCount(Number(e.target.value || 1))}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>支付方式</span>
                  <select
                    className="km-input"
                    value={purchasePayType}
                    onChange={(e) => setPurchasePayType(e.target.value === "wxpay" ? "wxpay" : "alipay")}
                  >
                    <option value="alipay">支付宝</option>
                    <option value="wxpay">微信</option>
                  </select>
                </label>
              </div>
              <button
                className="km-btn"
                disabled={busy || !purchasePlan}
                onClick={async () => {
                  const data = await postAction({
                    action: "create_purchase",
                    plan: purchasePlan,
                    count: purchaseCount,
                    payType: purchasePayType,
                  });
                  if (data?.pay_url) window.open(String(data.pay_url), "_blank", "noopener");
                  const next = await loadSection("purchase");
                  setPurchaseOrders(next?.list || []);
                  setPurchaseLastImport(next?.lastImport || null);
                }}
              >
                下单进货
              </button>
            </div>
            <div className="km-panel overflow-x-auto text-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold">主站进货单</h3>
                <button
                  className="km-btn km-btn-ghost text-sm"
                  onClick={async () => {
                    const data = await loadSection("purchase");
                    setPurchaseOrders(data?.list || []);
                    setPurchasePlans(data?.plans || []);
                    setPurchaseLastImport(data?.lastImport || null);
                  }}
                >
                  刷新
                </button>
              </div>
              <table className="km-table">
                <thead>
                  <tr>
                    <th>单号</th>
                    <th>套餐</th>
                    <th>数量</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseOrders.map((o) => (
                    <tr key={String(o.order_no)}>
                      <td className="font-mono text-xs">{String(o.order_no)}</td>
                      <td>{String(o.plan || "—")}</td>
                      <td>{String(o.count ?? "—")}</td>
                      <td>
                        <StatusBadge status={String(o.status || "—")} />
                      </td>
                      <td className="space-x-2">
                        {o.pay_url ? (
                          <a className="underline" href={String(o.pay_url)} target="_blank" rel="noreferrer">
                            去支付
                          </a>
                        ) : null}
                        <button
                          className="km-btn km-btn-ghost !px-2 !py-1 text-xs"
                          disabled={busy}
                          onClick={async () => {
                            const data = await postAction({ action: "repay_purchase", orderNo: o.order_no });
                            if (data?.pay_url) window.open(String(data.pay_url), "_blank", "noopener");
                          }}
                        >
                          重新支付
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!purchaseOrders.length ? <p className="py-4 text-[var(--km-fg-muted)]">暂无进货单</p> : null}
            </div>
          </div>
        ) : null}

        {tab === "integration" && integration ? (
          <div className="space-y-4">
            <div className="km-panel space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
                    接入上游
                  </h2>
                  <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
                    填写主站地址和代理 Key，路径会自动拼到 /api/v1/agent。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={`km-badge ${integration.apiKeyConfigured ? "km-badge-ok" : ""}`}>
                    {integration.apiKeyConfigured ? `Key ${integration.apiKeyHint}` : "Key 未配置"}
                  </span>
                  <span className={`km-badge ${integration.webhookSecretConfigured ? "km-badge-ok" : ""}`}>
                    {integration.webhookSecretConfigured ? `签名 ${integration.webhookSecretHint}` : "签名未配置"}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-2">
                  <div className="text-xs text-[var(--km-fg-muted)]">Agent 接口</div>
                  <code className="mt-1 block truncate text-sm" title={integration.agentApiBase}>
                    {integration.agentApiBase || "保存地址后显示"}
                  </code>
                </div>
                <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-xs text-[var(--km-fg-muted)]">
                    <span>Webhook 回调</span>
                    <button
                      className="underline"
                      onClick={() => void navigator.clipboard.writeText(integration.webhookCallbackUrl)}
                    >
                      复制
                    </button>
                  </div>
                  <code className="mt-1 block truncate text-sm" title={integration.webhookCallbackUrl}>
                    {integration.webhookCallbackUrl}
                  </code>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  <span>主站地址</span>
                  <input
                    className="km-input"
                    placeholder="https://your-cdk.example.com"
                    value={integForm.upstreamBaseUrl}
                    onChange={(e) => setIntegForm((s) => ({ ...s, upstreamBaseUrl: e.target.value }))}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>本站公网地址</span>
                  <input
                    className="km-input"
                    placeholder="https://kaimi.example.com"
                    value={integForm.publicBaseUrl}
                    onChange={(e) => setIntegForm((s) => ({ ...s, publicBaseUrl: e.target.value }))}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>API Key</span>
                  <input
                    className="km-input font-mono"
                    type="password"
                    placeholder={integration.apiKeyConfigured ? "留空则不修改" : "ak_live_…"}
                    value={integForm.upstreamApiKey}
                    onChange={(e) => setIntegForm((s) => ({ ...s, upstreamApiKey: e.target.value }))}
                    autoComplete="off"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Webhook 签名</span>
                  <input
                    className="km-input font-mono"
                    type="password"
                    placeholder={integration.webhookSecretConfigured ? "留空则不修改" : "whsec_…"}
                    value={integForm.webhookSecret}
                    onChange={(e) => setIntegForm((s) => ({ ...s, webhookSecret: e.target.value }))}
                    autoComplete="off"
                  />
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
                  <span>同步间隔（分钟）</span>
                  <input
                    className="km-input"
                    type="number"
                    min={0}
                    max={1440}
                    value={integForm.syncIntervalMinutes}
                    onChange={(e) =>
                      setIntegForm((s) => ({
                        ...s,
                        syncIntervalMinutes: Number(e.target.value || 0),
                      }))
                    }
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

              {integration.syncLastAt ? (
                <p className="text-xs text-[var(--km-fg-muted)]">
                  上次同步 {formatWhen(integration.syncLastAt)}
                  {integration.syncLastResult ? ` · ${integration.syncLastResult}` : ""}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button className="km-btn" disabled={busy} onClick={() => void saveIntegration()}>
                  保存
                </button>
                <button className="km-btn km-btn-ghost" disabled={busy} onClick={() => void testConnection()}>
                  连通检测
                </button>
                <button className="km-btn km-btn-ghost" disabled={busy} onClick={() => void syncStock()}>
                  同步库存
                </button>
                <button
                  className="km-btn km-btn-ghost"
                  disabled={busy}
                  onClick={async () => {
                    const data = await postAction({ action: "sync_plans" });
                    if (data?.ok) {
                      setMsg(
                        `套餐已同步 ${data.upserted ?? 0} 条，代充商品已更新 ${data.productsUpserted ?? data.upserted ?? 0} 条`,
                      );
                    } else setMsg(data?.error || "同步套餐失败");
                  }}
                >
                  同步套餐
                </button>
                <button
                  className="km-btn km-btn-ghost"
                  disabled={busy}
                  onClick={async () => {
                    const data = await postAction({ action: "reconcile_locks" });
                    if (data?.ok) setMsg(`锁对账：释放 ${data.released ?? 0}，核销 ${data.used ?? 0}`);
                  }}
                >
                  修复卡住的锁
                </button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="km-panel space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">Webhook 投递</h3>
                  <button
                    className="km-btn km-btn-ghost"
                    onClick={async () => {
                      const data = await loadSection("deliveries");
                      setDeliveries(data?.list || []);
                      if (data?.error) setMsg(data.error);
                    }}
                  >
                    刷新
                  </button>
                </div>
                <ul className="max-h-56 space-y-2 overflow-y-auto text-sm">
                  {deliveries.map((d, i) => (
                    <li key={String(d.id || d.event_id || i)} className="rounded-lg bg-[var(--km-bg-muted)] px-3 py-2">
                      <div className="km-clip font-mono text-xs">{String(d.event_type || d.event || "event")}</div>
                      <div className="text-xs text-[var(--km-fg-muted)]">
                        {STATUS_LABEL[String(d.status || d.result || "")] || String(d.status || d.result || "")} ·{" "}
                        {formatWhen(d.created_at || d.updated_at)}
                      </div>
                    </li>
                  ))}
                  {!deliveries.length ? (
                    <li className="py-6 text-center text-sm text-[var(--km-fg-muted)]">暂无投递</li>
                  ) : null}
                </ul>
              </div>

              <div className="km-panel space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">开通记录</h3>
                  <input
                    className="km-input max-w-[12rem]"
                    placeholder="邮箱或卡密"
                    value={recordQ}
                    onChange={(e) => setRecordQ(e.target.value)}
                  />
                  <button
                    className="km-btn km-btn-ghost"
                    onClick={async () => {
                      const data = await loadSection("records", recordQ ? `&q=${encodeURIComponent(recordQ)}` : "");
                      setRecords(data?.list || []);
                      if (data?.error) setMsg(data.error);
                    }}
                  >
                    查询
                  </button>
                </div>
                <ul className="max-h-56 space-y-2 overflow-y-auto text-sm">
                  {records.map((r) => (
                    <li key={String(r.request_id)} className="rounded-lg bg-[var(--km-bg-muted)] px-3 py-2">
                      <div className="km-clip font-mono text-xs">{String(r.request_id)}</div>
                      <div className="km-clip text-xs text-[var(--km-fg-muted)]">
                        {STATUS_LABEL[String(r.status || "")] || String(r.status || "")} · {String(r.account_email || "")}
                      </div>
                    </li>
                  ))}
                  {!records.length ? (
                    <li className="py-6 text-center text-sm text-[var(--km-fg-muted)]">暂无记录</li>
                  ) : null}
                </ul>
              </div>
            </div>

            {pingResult ? (
              <div className="km-panel space-y-2">
                <div className={pingResult.ok ? "text-[var(--km-success)]" : "text-[var(--km-danger)]"}>
                  {pingResult.ok ? "主站可达" : "探测失败"}
                </div>
                <p className="text-sm text-[var(--km-fg-muted)]">{pingResult.message}</p>
                {pingResult.plans?.length ? (
                  <ul className="grid gap-2 sm:grid-cols-3">
                    {pingResult.plans.map((p) => (
                      <li key={p.key} className="rounded-lg bg-[var(--km-bg-muted)] px-3 py-2 text-sm">
                        <div className="font-medium">{p.name || p.key}</div>
                        <div className="font-mono text-xs text-[var(--km-fg-muted)]">{p.key}</div>
                        {"price_yuan" in p && p.price_yuan ? (
                          <div className="text-xs text-[var(--km-fg-muted)]">¥{String(p.price_yuan)}</div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "appearance" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="km-panel space-y-3 lg:col-span-2">
              <div>
                <h3 className="font-semibold">整站外观</h3>
                <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
                  站点名和主题会应用到全部前台页面。浅色主题主按钮为近黑。
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
                    <option value="snow">暖纸白 / 近黑按钮</option>
                    <option value="aurora">深色 / 近白按钮</option>
                    <option value="ink">纯黑 / 近白按钮</option>
                    <option value="sakura">浅藕粉 / 近黑按钮</option>
                  </select>
                </label>
                <label className="block space-y-1 text-sm sm:col-span-2">
                  <span>购买卡密外链</span>
                  <input
                    className="km-input"
                    value={buyCdkUrl}
                    onChange={(e) => setBuyCdkUrl(e.target.value)}
                    placeholder="https://your-store.example.com"
                  />
                  <span className="text-xs text-[var(--km-fg-muted)]">留空则前台不显示购买入口。</span>
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
                  setMsg("页面文案已保存");
                }}
              />
            ))}
          </div>
        ) : null}

        {tab === "guide" ? <AdminGuide onGo={setTab} /> : null}
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
