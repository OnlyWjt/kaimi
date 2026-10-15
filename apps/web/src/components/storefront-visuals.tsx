"use client";

import { useState, type ReactNode } from "react";
import { pickText, type ContactItem, type Lang, type StorefrontProduct } from "@/lib/agent-storefront-config";

/* ———————————————————————————— 图标 ———————————————————————————— */

export function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.2" />
      <path d="M16.2 16.2 20 20" strokeLinecap="round" />
    </svg>
  );
}

export function IconGlobe() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="7.2" />
      <path d="M5 12h14M12 5c2.2 2.1 3.3 4.5 3.3 7s-1.1 4.9-3.3 7c-2.2-2.1-3.3-4.5-3.3-7s1.1-4.9 3.3-7Z" />
    </svg>
  );
}

export function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M7 17 17 7M9.5 7H17v7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconBack() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M11 6.5 5.5 12l5.5 5.5M5.5 12H19" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconMail() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" />
      <path d="m4.5 7.5 7.5 5.6 7.5-5.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconLock() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5.5" y="10.5" width="13" height="9" rx="2.2" />
      <path d="M8.5 10.5V8.2a3.5 3.5 0 0 1 7 0v2.3" strokeLinecap="round" />
    </svg>
  );
}

export function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
      <path d="M13 2 4.5 13.5H11L9.8 22 19 10h-6.5L13 2Z" />
    </svg>
  );
}

export function IconMegaphone() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 10v4a1.5 1.5 0 0 0 1.5 1.5H8L18 20V4L8 8.5H5.5A1.5 1.5 0 0 0 4 10Z" strokeLinejoin="round" />
      <path d="M18 9.5a3.5 3.5 0 0 1 0 5" strokeLinecap="round" />
    </svg>
  );
}

export function IconSend() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 3.5 10.2 13.8M21 3.5 14 21l-3.8-7.2L3 10l18-6.5Z" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChat() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4.5 6.5a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H10l-4.2 3.4a.6.6 0 0 1-1-.5V6.5Z" strokeLinejoin="round" />
    </svg>
  );
}

export function ContactIcon({ type }: { type: ContactItem["type"] }) {
  if (type === "telegram") return <IconSend />;
  if (type === "email") return <IconMail />;
  if (type === "link") return <IconGlobe />;
  return <IconChat />;
}

export function contactFallbackLabel(type: ContactItem["type"]): { zh: string; en: string } {
  if (type === "telegram") return { zh: "Telegram", en: "Telegram" };
  if (type === "email") return { zh: "售后邮箱", en: "Support email" };
  if (type === "wechat") return { zh: "微信客服", en: "WeChat" };
  if (type === "qq") return { zh: "QQ 客服", en: "QQ" };
  return { zh: "联系我们", en: "Contact" };
}

export function ProductIcon({ product }: { product: StorefrontProduct }) {
  return (
    <span
      className="km-sf-p-icon"
      style={{
        color: `hsl(${product.hue} 28% 34%)`,
        borderColor: `hsl(${product.hue} 18% 78%)`,
        background: `hsl(${product.hue} 22% 96%)`,
      }}
      aria-hidden
    >
      {product.mark}
    </span>
  );
}

export function CoverPhoto({
  src,
  fallback,
}: {
  src?: string;
  fallback: ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return fallback;
  // 封面可能是代理贴的任意外链，next/image 要先配远程域名白名单，这里直接用 img
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" onError={() => setBroken(true)} />;
}

/** 详情页左侧商品主图：有封面用图，裂了或没图就退回短标识 */
export function ProductBanner({ product, lang }: { product: StorefrontProduct; lang: Lang }) {
  const photo = (
    <CoverPhoto
      src={product.cover}
      fallback={
        <span
          className="km-sf-banner-icon"
          style={{
            color: `hsl(${product.hue} 28% 34%)`,
            borderColor: `hsl(${product.hue} 18% 78%)`,
            background: `hsl(${product.hue} 22% 96%)`,
          }}
          aria-hidden
        >
          {product.mark}
        </span>
      }
    />
  );
  if (product.cover) {
    return <div className="km-sf-banner km-sf-banner-photo">{photo}</div>;
  }
  return (
    <div
      className="km-sf-banner"
      style={{
        background: `linear-gradient(180deg, hsl(${product.hue} 16% 97%), color-mix(in oklab, var(--km-bg-muted) 55%, var(--km-bg-elevated)))`,
      }}
    >
      <span
        className="km-sf-banner-icon"
        style={{
          color: `hsl(${product.hue} 28% 34%)`,
          borderColor: `hsl(${product.hue} 18% 78%)`,
          background: `hsl(${product.hue} 22% 96%)`,
        }}
        aria-hidden
      >
        {product.mark}
      </span>
      <span className="km-sf-banner-cap">{pickText(product.subtitle, lang)}</span>
    </div>
  );
}
