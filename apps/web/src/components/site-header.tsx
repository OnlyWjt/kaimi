"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavLink = {
  href: string;
  label: string;
  external?: boolean;
};

export function buildPublicNavLinks(): NavLink[] {
  return [
    { href: "/recharge", label: "开始兑换" },
    { href: "/cdk", label: "卡密查询" },
    { href: "/lookup", label: "订单进度" },
  ];
}

function isActivePath(href: string, pathname: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader(props: {
  siteName: string;
  links?: NavLink[];
}) {
  const pathname = usePathname() || "/";
  const links = props.links ?? buildPublicNavLinks();

  return (
    <header className="km-header">
      <div className="km-shell km-header-inner">
        <Link href="/" className="km-brand">
          <span className="km-brand-mark" aria-hidden>
            K
          </span>
          <span className="km-brand-name">{props.siteName}</span>
        </Link>
        <nav className="km-nav" aria-label="站点导航">
          {links.map((l) => {
            const active = !l.external && isActivePath(l.href, pathname);
            const className = `km-nav-link${active ? " km-nav-link-active" : ""}`;
            return l.external ? (
              <a
                key={l.href}
                href={l.href}
                className={className}
                target="_blank"
                rel="noopener noreferrer"
              >
                {l.label}
              </a>
            ) : (
              <Link key={l.href} href={l.href} className={className}>
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter({ note }: { note?: string }) {
  return (
    <footer className="km-shell pb-12 pt-2 text-center text-sm text-[var(--km-fg-muted)]">
      {note || "卡密兑换开通"}
    </footer>
  );
}
