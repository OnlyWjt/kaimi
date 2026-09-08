import type { ReactNode } from "react";
import Link from "next/link";
import { ApplyTheme } from "@/components/apply-theme";
import type { AgentShopChromeData } from "@/lib/agent-shop";
import { pickText, type ContactItem } from "@/lib/agent-storefront-config";

export type ShopTool = "redeem" | "cdk" | "lookup";

function contactHref(contact: ContactItem) {
  if (contact.type === "email") return `mailto:${contact.value}`;
  if (contact.type === "telegram") {
    return `https://t.me/${contact.value.replace(/^@/, "")}`;
  }
  if (contact.type === "link") return contact.value;
  return "";
}

function contactLabel(contact: ContactItem) {
  if (contact.type === "telegram") return "Telegram";
  if (contact.type === "email") return "售后邮箱";
  if (contact.type === "wechat") return "微信客服";
  if (contact.type === "qq") return "QQ 客服";
  return pickText(contact.label, "zh") || "联系我们";
}

export function AgentShopChrome({
  shop,
  active,
  children,
}: {
  shop: AgentShopChromeData;
  active: ShopTool;
  children: ReactNode;
}) {
  const brandLetter = (shop.logoLetter || shop.shopName.trim().charAt(0) || "K").toUpperCase();
  const links: { id: ShopTool; href: string; label: string }[] = [
    { id: "redeem", href: `/s/${shop.slug}/recharge`, label: "去兑换" },
    { id: "cdk", href: `/s/${shop.slug}/cdk`, label: "卡密查询" },
    { id: "lookup", href: `/s/${shop.slug}/lookup`, label: "订单进度" },
  ];

  return (
    <main data-theme={shop.themeId} className="km-sf km-themed-page km-rx">
      <ApplyTheme themeId={shop.themeId} />
      <header className="km-sf-header">
        <div className="km-shell-wide km-sf-header-inner">
          <Link href={`/s/${shop.slug}`} className="km-brand min-w-0">
            <span className="km-sf-brand-mark grid place-items-center" aria-hidden>
              {brandLetter}
            </span>
            <span className="km-brand-name">{shop.shopName}</span>
          </Link>
          <nav className="km-sf-nav-pill" aria-label="店铺工具">
            {links.map((link) => (
              <Link
                key={link.id}
                href={link.href}
                className={`km-sf-nav-item${active === link.id ? " km-sf-nav-item-active" : ""}${
                  link.id === "redeem" ? " km-sf-nav-redeem" : ""
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="km-sf-tools" />
        </div>
      </header>
      {children}
      <footer className="km-shell space-y-2 pb-12 pt-4 text-center text-sm text-[var(--km-fg-muted)]">
        {shop.footerNote ? <p>{shop.footerNote}</p> : null}
        {shop.contacts.length ? (
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
            {shop.contacts.map((contact, index) => {
              const href = contactHref(contact);
              const text = `${contactLabel(contact)}：${contact.value}`;
              return href ? (
                <a key={`${contact.type}-${index}`} href={href} target="_blank" rel="noreferrer">
                  {text}
                </a>
              ) : (
                <span key={`${contact.type}-${index}`}>{text}</span>
              );
            })}
          </div>
        ) : null}
        <p>© {new Date().getFullYear()} {shop.shopName}</p>
      </footer>
    </main>
  );
}
