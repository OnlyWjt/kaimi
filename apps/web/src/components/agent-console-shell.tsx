"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { AgentAnnouncementModal } from "@/components/agent-announcement-modal";
import type { AgentConsoleProfile } from "@/lib/agent-console-core";
import { publicShopName } from "@/lib/agent-names";
import { agentAnnouncementHint } from "@/lib/announcements-core";
import { isExternalRedeemUrl } from "@/lib/agent-redeem-core";
import type { ContactGate } from "@/lib/agent-contact-core";
import { formatDateTime } from "@/lib/datetime";
import "./agent-console.css";

/** 没填售后联系方式时每一页都挂着，直到填好。 */
function ContactRequiredBanner({ gate }: { gate: Exclude<ContactGate, { state: "ok" }> }) {
  return (
    <div className="km-acp-warn mb-4 flex flex-wrap items-center justify-between gap-3">
      <span className={gate.state === "blocked" ? "text-[var(--km-danger)]" : undefined}>
        {gate.state === "blocked"
          ? "店铺已暂停接单：还没有填写售后联系方式（微信、QQ 或 Telegram）。填好后立即恢复。"
          : `请在 ${formatDateTime(gate.deadline)} 前填写售后联系方式（微信、QQ 或 Telegram），否则店铺会暂停接单。`}
      </span>
      <Link href="/agent/storefront" className="km-btn km-btn-primary">
        去填写
      </Link>
    </div>
  );
}

const NAV = [
  { href: "/agent", label: "概览", group: "日常" },
  { href: "/agent/notices", label: "公告", group: "日常" },
  { href: "/agent/notify", label: "通知", group: "日常" },
  { href: "/agent/orders", label: "订单", group: "销售" },
  { href: "/agent/sell", label: "售价与优惠", group: "销售" },
  { href: "/agent/referral", label: "邀请有礼", group: "销售" },
  { href: "/agent/storefront", label: "店铺装修", group: "销售" },
  { href: "/agent/books", label: "账本", group: "账务" },
  { href: "/agent/draw", label: "自助提卡", group: "账务" },
  { href: "/agent/codes", label: "卡密查询", group: "账务" },
  { href: "/agent/api", label: "开放 API", group: "账务" },
] as const;

const TOOLS = [
  { href: "/agent/guide", label: "使用说明" },
  { href: "/agent/batch-redeem", label: "批量兑换" },
] as const;

function navActive(href: string, pathname: string) {
  if (href === "/agent") return pathname === "/agent";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AgentConsoleShell({
  profile,
  children,
}: {
  profile: AgentConsoleProfile;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/agent";
  const router = useRouter();
  const { ask, dialog } = useAskDialog();
  const [origin, setOrigin] = useState("");
  const [pendingHref, setPendingHref] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [dismissedId, setDismissedId] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const unread = profile.unreadAnnouncement;
  const showModal =
    Boolean(unread) &&
    unread?.id !== dismissedId &&
    pathname !== "/agent/notices";
  const shopPath = `/s/${profile.currentSlug}`;
  const shopUrl = origin ? `${origin}${shopPath}` : shopPath;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    setPendingHref("");
    setMenuOpen(false);
  }, [pathname]);

  const current =
    [...NAV, ...TOOLS].find((item) => navActive(item.href, pendingHref || pathname))?.label ?? "代理后台";
  const hasUnread = Boolean(unread) && unread?.id !== dismissedId;

  async function copyShop() {
    try {
      await navigator.clipboard.writeText(shopUrl);
      toast("店铺链接已复制");
    } catch {
      toast("复制失败，请手动复制", "err");
    }
  }

  async function changePassword() {
    const answer = await ask({
      title: "修改登录密码",
      message:
        "改完这里就用新密码登录，其他设备上已经登录的会被退出。忘了当前密码就找管理员重置。",
      fields: [
        {
          name: "current",
          label: "当前密码",
          type: "password",
          autoComplete: "current-password",
          required: true,
        },
        {
          name: "next",
          label: "新密码",
          type: "password",
          autoComplete: "new-password",
          required: true,
          minLength: 8,
          mustDiffer: "current",
          hint: "至少 8 位。",
        },
        {
          name: "confirm",
          label: "确认新密码",
          type: "password",
          autoComplete: "new-password",
          required: true,
          mustMatch: "next",
        },
      ],
      confirmLabel: "修改密码",
    });
    if (!answer) return;
    setPasswordBusy(true);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "change_password",
          currentPassword: answer.current,
          newPassword: answer.next,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "密码修改失败");
      }
      toast("密码已改好，下次登录用新密码");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "密码修改失败", "err");
    } finally {
      setPasswordBusy(false);
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

  return (
    <div className="km-acp">
      <ApplyTheme themeId={profile.themeId} />
      <header className="km-acp-mbar">
        <button
          type="button"
          className="km-acp-mbar-btn"
          aria-expanded={menuOpen}
          aria-controls="km-acp-side"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden>{menuOpen ? "✕" : "☰"}</span>
          {hasUnread ? <i className="km-acp-dot" aria-hidden /> : null}
        </button>
        <strong>{current}</strong>
        <a className="km-acp-mbar-shop" href={shopPath} target="_blank" rel="noreferrer">
          店铺 ↗
        </a>
      </header>
      {menuOpen ? <div className="km-acp-scrim" onClick={() => setMenuOpen(false)} /> : null}
      <div className="km-acp-frame">
        <aside id="km-acp-side" className={`km-acp-side${menuOpen ? " is-open" : ""}`}>
          <div className="km-acp-brand">
            <strong>{publicShopName(profile)} 的店</strong>
            <small>登录账号 {profile.username}</small>
          </div>
          <nav className="km-acp-nav" aria-label="代理后台">
            {NAV.map((item, index) => (
              <div key={item.href}>
                {index === 0 || NAV[index - 1].group !== item.group ? (
                  <div className="km-acp-nav-label">{item.group}</div>
                ) : null}
                <Link
                  href={item.href}
                  prefetch
                  className={navActive(item.href, pendingHref || pathname) ? "is-on" : ""}
                  onClick={() => setPendingHref(item.href)}
                >
                  {item.label}
                  {item.href === "/agent/notices" && hasUnread ? (
                    <i className="km-acp-dot" aria-label={agentAnnouncementHint(true)} />
                  ) : null}
                </Link>
              </div>
            ))}
            <div className="km-acp-nav-label">工具</div>
            {TOOLS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                className={navActive(item.href, pendingHref || pathname) ? "is-on" : ""}
                onClick={() => setPendingHref(item.href)}
              >
                {item.label}
              </Link>
            ))}
            <a
              href={profile.redeemUrl}
              {...(isExternalRedeemUrl(profile.redeemUrl)
                ? { target: "_blank", rel: "noreferrer" }
                : {})}
            >
              兑换卡密
              <span aria-hidden className="km-acp-ext">↗</span>
            </a>
          </nav>
          <div className="km-acp-shopchip">
            <span className="text-xs text-[var(--km-fg-muted)]">店铺一直在手边</span>
            <code>{shopUrl}</code>
            <div className="km-acp-tools">
              <a className="km-btn km-btn-ghost" href={shopPath} target="_blank" rel="noreferrer">
                打开
              </a>
              <button type="button" className="km-btn km-btn-ghost" onClick={() => void copyShop()}>
                复制
              </button>
            </div>
          </div>
          <div className="km-acp-account">
            <button
              type="button"
              className="km-btn km-btn-ghost"
              disabled={passwordBusy}
              onClick={() => void changePassword()}
            >
              {passwordBusy ? "修改中…" : "修改密码"}
            </button>
            <button type="button" className="km-btn km-btn-ghost" onClick={() => void logout()}>
              退出登录
            </button>
          </div>
        </aside>
        <div className="km-acp-main">
          {profile.contactGate.state !== "ok" ? (
            <ContactRequiredBanner gate={profile.contactGate} />
          ) : null}
          {children}
        </div>
      </div>
      {dialog}
      {showModal && unread ? (
        <AgentAnnouncementModal
          item={unread}
          onRead={() => {
            setDismissedId(unread.id);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
