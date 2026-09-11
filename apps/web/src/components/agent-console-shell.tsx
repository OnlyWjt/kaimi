"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import type { AgentConsoleProfile } from "@/lib/agent-console-core";
import { isExternalRedeemUrl } from "@/lib/agent-redeem-core";
import "./agent-console.css";

const NAV = [
  { href: "/agent", label: "概览", hint: "店况", group: "每天看" },
  { href: "/agent/sell", label: "售价与优惠", hint: "定价", group: "怎么卖" },
  { href: "/agent/storefront", label: "店铺", hint: "装修", group: "怎么卖" },
  { href: "/agent/books", label: "账本", hint: "收益", group: "钱和量" },
  { href: "/agent/codes", label: "已售卡密", hint: "售后", group: "钱和量" },
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
  const [passwordBusy, setPasswordBusy] = useState(false);
  const shopPath = `/s/${profile.currentSlug}`;
  const shopUrl = origin ? `${origin}${shopPath}` : shopPath;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

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
      <div className="km-acp-frame">
        <aside className="km-acp-side">
          <div className="km-acp-brand">
            <strong>{profile.displayName} 的店</strong>
            <small>登录账号 {profile.username}</small>
          </div>
          <nav className="km-acp-nav" aria-label="代理后台">
            {NAV.map((item, index) => (
              <div key={item.href}>
                {index === 0 || NAV[index - 1].group !== item.group ? (
                  <div className="km-acp-nav-label">{item.group}</div>
                ) : null}
                <Link href={item.href} className={navActive(item.href, pathname) ? "is-on" : ""}>
                  {item.label}
                  <em>{item.hint}</em>
                </Link>
              </div>
            ))}
            <div className="km-acp-nav-label">工具</div>
            <Link href="/agent/guide" className={navActive("/agent/guide", pathname) ? "is-on" : ""}>
              使用说明
              <em>第一次</em>
            </Link>
            <a
              href={profile.redeemUrl}
              {...(isExternalRedeemUrl(profile.redeemUrl)
                ? { target: "_blank", rel: "noreferrer" }
                : {})}
            >
              兑换卡密
              <em>开通</em>
            </a>
            <Link
              href="/agent/batch-redeem"
              className={navActive("/agent/batch-redeem", pathname) ? "is-on" : ""}
            >
              批量兑换
              <em>工具</em>
            </Link>
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
        <div className="km-acp-main">{children}</div>
      </div>
      {dialog}
    </div>
  );
}
