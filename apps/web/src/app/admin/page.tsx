"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AdminAgents } from "@/components/admin-agents";
import { AdminApiKeys } from "@/components/admin-api-keys";
import { ADMIN_UNAUTHORIZED_EVENT } from "@/components/admin-api";
import { AdminRedeemGuard } from "@/components/admin-redeem-guard";
import { AdminAnnouncements } from "@/components/admin-announcements";
import { AdminCdks } from "@/components/admin-cdks";
import { AdminGuide } from "@/components/admin-guide";
import { AdminOrders, type AdminOrderKind } from "@/components/admin-orders";
import { AdminOverview } from "@/components/admin-overview";
import { AdminAppearance, AdminIntegration, AdminNotify } from "@/components/admin-site-settings";
import { CardSelectionConfig } from "@/components/card-selection-config";
import { AdminEarningsStats } from "@/components/admin-earnings-stats";
import { AdminAgentDraw } from "@/components/admin-agent-draw";
import { AdminReferral } from "@/components/admin-referral";
import { AdminUsageStats } from "@/components/admin-usage-stats";
import { AdminWeeklyEarnings } from "@/components/admin-weekly-earnings";
import { AdminReconciliation } from "@/components/admin-reconciliation";
import { CommerceAdmin } from "@/components/commerce-admin";
import { FinishedAccountsAdmin } from "@/components/finished-accounts-admin";
import { toast } from "@/components/toast";

type Tab =
  | "overview"
  | "orders"
  | "cdks"
  | "integration"
  | "notify"
  | "selection"
  | "commerce"
  | "finished"
  | "agents"
  | "guard"
  | "apikeys"
  | "announcements"
  | "draw"
  | "referral"
  | "earnings"
  | "usage"
  | "week"
  | "reconcile"
  | "appearance"
  | "guide";

/** 「订单」页直接停在店铺订单那一栏。 */
const STORE_ORDERS_HASH = "store-orders";

const GROUPS: ReadonlyArray<{ id: string; name: string; items: ReadonlyArray<readonly [Tab, string]> }> = [
  {
    id: "daily",
    name: "日常",
    items: [
      ["overview", "总览"],
      ["orders", "订单"],
      ["cdks", "卡密"],
      ["usage", "用量"],
    ],
  },
  {
    id: "sell",
    name: "卖卡",
    items: [
      ["commerce", "售卖设置"],
      ["finished", "成品号"],
      ["selection", "选卡配置"],
    ],
  },
  {
    id: "agent",
    name: "代理",
    items: [
      ["agents", "代理管理"],
      ["draw", "提卡账本"],
      ["referral", "邀请返券"],
      ["reconcile", "对账"],
      ["week", "历史周结"],
      ["earnings", "收益统计"],
    ],
  },
  {
    id: "system",
    name: "系统",
    items: [
      ["integration", "接入卡台"],
      ["notify", "通知"],
      ["guard", "兑换拦截"],
      ["apikeys", "开放 API"],
      ["announcements", "公告"],
      ["appearance", "外观"],
      ["guide", "使用说明"],
    ],
  },
];

const ALL_TABS = new Set<string>(GROUPS.flatMap((group) => group.items.map(([id]) => id)));

function tabFromHash(hash: string): Tab | null {
  if (hash === "card-selection") return "selection";
  if (hash === STORE_ORDERS_HASH) return "orders";
  return ALL_TABS.has(hash) ? (hash as Tab) : null;
}

export default function AdminPage() {
  const [boot, setBoot] = useState<{ admin: { username: string } | null } | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [orderKind, setOrderKind] = useState<AdminOrderKind>("");
  const [loginForm, setLoginForm] = useState({ username: "admin", password: "" });
  const [msg, setMsg] = useState("");

  function goTab(next: Tab) {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  function changeOrderKind(next: AdminOrderKind) {
    setOrderKind(next);
    window.history.replaceState(null, "", next === "store" ? `#${STORE_ORDERS_HASH}` : "#orders");
  }

  function goStoreOrders() {
    setTab("orders");
    changeOrderKind("store");
  }

  async function refreshBoot() {
    const res = await fetch("/api/setup");
    setBoot(await res.json());
  }

  useEffect(() => {
    void refreshBoot();
    function applyLocation() {
      const queryTab = new URLSearchParams(window.location.search).get("tab");
      const hash = window.location.hash.replace("#", "");
      const next = tabFromHash(queryTab || "") || tabFromHash(hash);
      if (hash === STORE_ORDERS_HASH) setOrderKind("store");
      if (next) setTab(next);
    }
    function onUnauthorized() {
      setBoot((current) => (current ? { ...current, admin: null } : current));
    }
    applyLocation();
    window.addEventListener("hashchange", applyLocation);
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      window.removeEventListener("hashchange", applyLocation);
      window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  const activeGroup = useMemo(
    () => GROUPS.find((group) => group.items.some(([id]) => id === tab)) || GROUPS[0],
    [tab],
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
          <div className="flex flex-wrap gap-2">
            {GROUPS.map((group) => (
              <button
                key={group.id}
                type="button"
                className={`rounded-full px-3 py-1 text-sm ${activeGroup.id === group.id ? "bg-[var(--km-fg)] text-[var(--km-bg)]" : "bg-[var(--km-bg-muted)]"}`}
                onClick={() => goTab(group.items[0][0])}
              >
                {group.name}
              </button>
            ))}
          </div>
          <nav className="km-tabs" aria-label="后台分区">
            {activeGroup.items.map(([id, label]) => (
              <button key={id} className={`km-tab ${tab === id ? "km-tab-active" : ""}`} onClick={() => goTab(id)}>
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <section className="km-shell-wide space-y-4 py-6 pb-16">
        {tab === "overview" ? (
          <AdminOverview
            onGoCommerce={() => goTab("commerce")}
            onGoStoreOrders={goStoreOrders}
            onGoGuide={() => goTab("guide")}
          />
        ) : null}
        {tab === "orders" ? <AdminOrders kind={orderKind} onKindChange={changeOrderKind} /> : null}
        {tab === "cdks" ? <AdminCdks /> : null}
        {tab === "usage" ? <AdminUsageStats /> : null}

        {tab === "commerce" ? <CommerceAdmin embedded /> : null}
        {tab === "finished" ? <FinishedAccountsAdmin /> : null}
        {tab === "selection" ? <CardSelectionConfig /> : null}

        {tab === "agents" ? <AdminAgents /> : null}
        {tab === "draw" ? <AdminAgentDraw /> : null}
        {tab === "referral" ? <AdminReferral /> : null}
        {tab === "reconcile" ? <AdminReconciliation /> : null}
        {tab === "week" ? <AdminWeeklyEarnings /> : null}
        {tab === "earnings" ? <AdminEarningsStats /> : null}

        {tab === "integration" ? <AdminIntegration /> : null}
        {tab === "notify" ? <AdminNotify /> : null}
        {tab === "guard" ? <AdminRedeemGuard /> : null}
        {tab === "apikeys" ? <AdminApiKeys /> : null}
        {tab === "announcements" ? <AdminAnnouncements /> : null}
        {tab === "appearance" ? <AdminAppearance /> : null}
        {tab === "guide" ? <AdminGuide onGo={goTab} /> : null}
      </section>
    </main>
  );
}
