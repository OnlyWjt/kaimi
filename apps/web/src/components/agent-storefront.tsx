"use client";

import { useEffect, useMemo, useState } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
import { publicStatusLabel } from "@/lib/status-labels";
import { THEME_CHOICES } from "@/lib/themes";
import {
  PLATFORM_HERO,
  PLATFORM_SLOGAN,
  pickText,
  type ContactItem,
  type Lang,
  type StorefrontConfig,
  type StorefrontProduct,
} from "@/lib/agent-storefront-config";
import { isThemeId, type ThemeId } from "@kaimi/themes";

type Channel = "alipay" | "wxpay";

type EmailOrder = {
  orderNo: string;
  productName: string;
  quantity?: number;
  amountCents: number;
  payStatus: string;
  fulfillStatus: string;
  queryToken: string;
};

const CHANNEL_LABEL: Record<Channel, { zh: string; en: string }> = {
  alipay: { zh: "支付宝", en: "Alipay" },
  wxpay: { zh: "微信支付", en: "WeChat Pay" },
};

/* ———————————————————————————— 界面文案（平台内置，不开放代理修改） ———————————————————————————— */

const I18N = {
  zh: {
    nav: { home: "首页", products: "商品中心", query: "订单查询", contact: "联系客服" },
    searchPlaceholder: "搜索商品名称…",
    queryTitle: "邮箱查单",
    queryDesc: "输入下单时填写的邮箱，即可查询该邮箱在本店的全部订单与卡密。",
    queryPlaceholder: "you@example.com",
    queryButton: "查询订单",
    queryBusy: "正在查询…",
    queryNote: "无需注册账号，用下单时填写的邮箱就能找回订单与卡密",
    queryEmpty: "这个邮箱在本店还没有订单",
    queryScope: "只显示这个邮箱在本店的订单，和其他买家互不影响。",
    productsSub: "浏览当前可售套餐，付款后即时发卡",
    priceFrom: (n: string) => `¥${n} 起`,
    stock: (n: number) => `库存 ${n} 件`,
    inStockShort: "现货",
    buyNow: "立即购买",
    empty: "当前暂无可售套餐",
    allCategory: "全部",
    detail: {
      crumbHome: "首页",
      crumbProducts: "商品中心",
      category: "分类",
      priceLabel: "价格",
      chooseSpec: "选择规格",
      auto: "自动发货",
      inStock: "有库存",
      qty: "购买数量",
      qtyMax: (n: number) => `一次最多 ${n} 张`,
      stock: (n: number) => `库存 ${n} 件`,
      email: "接收邮箱",
      emailHint: "用于付款后查回订单与卡密，请填常用邮箱",
      emailRequired: "请先填写接收邮箱",
      channel: "支付方式",
      channelEmpty: "支付方式暂未开放",
      total: "应付金额",
      pay: "立即购买",
      payBusy: "正在创建订单…",
      previewNote: "预览模式不会真的下单",
      infoTitle: "详细资讯",
      back: "返回商品列表",
      secure: "自动发货 · 即买即用",
    },
    footerLinks: "便捷链接",
    footerContact: "联系客服",
    rights: "版权所有",
    previewTip: "静态预览 · 点色板看各套主题",
    langLabel: "EN",
  },
  en: {
    nav: { home: "Home", products: "Products", query: "Track Order", contact: "Support" },
    searchPlaceholder: "Search products…",
    queryTitle: "Track by email",
    queryDesc: "Enter the email you used at checkout to look up all orders and codes in this shop.",
    queryPlaceholder: "you@example.com",
    queryButton: "Look up orders",
    queryBusy: "Looking up…",
    queryNote: "No account needed — use the email from checkout to find your orders and codes",
    queryEmpty: "No orders found for this email in this shop",
    queryScope: "Only orders placed with this email in this shop are shown.",
    productsSub: "Browse available plans, codes delivered instantly after payment",
    priceFrom: (n: string) => `From ¥${n}`,
    stock: (n: number) => `${n} in stock`,
    inStockShort: "In stock",
    buyNow: "Buy now",
    empty: "No plans available right now",
    allCategory: "All",
    detail: {
      crumbHome: "Home",
      crumbProducts: "Products",
      category: "Category",
      priceLabel: "Price",
      chooseSpec: "Choose a plan",
      auto: "Auto delivery",
      inStock: "In stock",
      qty: "Quantity",
      qtyMax: (n: number) => `Up to ${n} per order`,
      stock: (n: number) => `${n} in stock`,
      email: "Delivery email",
      emailHint: "Used to retrieve your order and codes after payment",
      emailRequired: "Please enter your email first",
      channel: "Payment method",
      channelEmpty: "No payment method available",
      total: "Total",
      pay: "Buy now",
      payBusy: "Creating order…",
      previewNote: "Preview mode does not place real orders",
      infoTitle: "Details",
      back: "Back to products",
      secure: "Auto delivery · ready to use",
    },
    footerLinks: "Quick links",
    footerContact: "Contact",
    rights: "All rights reserved",
    previewTip: "Static preview · click swatches to try themes",
    langLabel: "中",
  },
} as const;

/* ———————————————————————————— 图标 ———————————————————————————— */

function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.2" />
      <path d="M16.2 16.2 20 20" strokeLinecap="round" />
    </svg>
  );
}

function IconOrders() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 7h10M7 12h10M7 17h6" strokeLinecap="round" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="7.2" />
      <path d="M5 12h14M12 5c2.2 2.1 3.3 4.5 3.3 7s-1.1 4.9-3.3 7c-2.2-2.1-3.3-4.5-3.3-7s1.1-4.9 3.3-7Z" />
    </svg>
  );
}

function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M7 17 17 7M9.5 7H17v7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBack() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M11 6.5 5.5 12l5.5 5.5M5.5 12H19" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" />
      <path d="m4.5 7.5 7.5 5.6 7.5-5.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5.5" y="10.5" width="13" height="9" rx="2.2" />
      <path d="M8.5 10.5V8.2a3.5 3.5 0 0 1 7 0v2.3" strokeLinecap="round" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
      <path d="M13 2 4.5 13.5H11L9.8 22 19 10h-6.5L13 2Z" />
    </svg>
  );
}

function IconMegaphone() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 10v4a1.5 1.5 0 0 0 1.5 1.5H8L18 20V4L8 8.5H5.5A1.5 1.5 0 0 0 4 10Z" strokeLinejoin="round" />
      <path d="M18 9.5a3.5 3.5 0 0 1 0 5" strokeLinecap="round" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 3.5 10.2 13.8M21 3.5 14 21l-3.8-7.2L3 10l18-6.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4.5 6.5a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H10l-4.2 3.4a.6.6 0 0 1-1-.5V6.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function ContactIcon({ type }: { type: ContactItem["type"] }) {
  if (type === "telegram") return <IconSend />;
  if (type === "email") return <IconMail />;
  if (type === "link") return <IconGlobe />;
  return <IconChat />;
}

function contactHref(contact: ContactItem): string | null {
  if (contact.type === "email") return `mailto:${contact.value}`;
  if (contact.type === "telegram") return `https://t.me/${contact.value.replace(/^@/, "")}`;
  if (contact.type === "link") return contact.value;
  return null;
}

function contactFallbackLabel(type: ContactItem["type"]): { zh: string; en: string } {
  if (type === "telegram") return { zh: "Telegram", en: "Telegram" };
  if (type === "email") return { zh: "售后邮箱", en: "Support email" };
  if (type === "wechat") return { zh: "微信客服", en: "WeChat" };
  if (type === "qq") return { zh: "QQ 客服", en: "QQ" };
  return { zh: "联系我们", en: "Contact" };
}

function ProductIcon({ product }: { product: StorefrontProduct }) {
  return (
    <span
      className="km-sf-p-icon"
      style={{
        background: `linear-gradient(140deg, hsl(${product.hue} 82% 60%), hsl(${product.hue + 32} 78% 48%))`,
      }}
      aria-hidden
    >
      {product.mark}
    </span>
  );
}

/** 详情页左侧商品主图：暂用渐变卡 + 短标识，等后台支持上传封面后换成真实图 */
function ProductBanner({ product, lang }: { product: StorefrontProduct; lang: Lang }) {
  return (
    <div
      className="km-sf-banner"
      style={{
        background: `radial-gradient(110% 100% at 22% 14%, hsl(${product.hue} 58% 90% / 0.55), transparent 62%),
          linear-gradient(155deg, color-mix(in oklab, var(--km-bg-muted) 78%, var(--km-bg-elevated)), color-mix(in oklab, hsl(${product.hue} 70% 55%) 9%, var(--km-bg-elevated)))`,
      }}
    >
      <span
        className="km-sf-banner-icon"
        style={{
          background: `linear-gradient(140deg, hsl(${product.hue} 82% 62%), hsl(${product.hue + 32} 78% 46%))`,
        }}
        aria-hidden
      >
        {product.mark}
      </span>
      <span className="km-sf-banner-cap">{pickText(product.subtitle, lang)}</span>
    </div>
  );
}

/* ———————————————————————————— 主组件 ———————————————————————————— */

export function AgentStorefront({
  config,
  preview = false,
  slug = "",
  channels = [],
  maxQuantity = 5,
}: {
  config: StorefrontConfig;
  /** 预览模式：显示主题色板、不真的下单 */
  preview?: boolean;
  slug?: string;
  channels?: Channel[];
  maxQuantity?: number;
}) {
  const [themeId, setThemeId] = useState<ThemeId>(
    isThemeId(config.themeId) ? config.themeId : "snow",
  );
  const [lang, setLang] = useState<Lang>(config.defaultLang);
  const [nav, setNav] = useState<"home" | "products" | "query" | "contact">("home");
  const [filter, setFilter] = useState("all");
  const [keyword, setKeyword] = useState("");

  const [queryEmail, setQueryEmail] = useState("");
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [myOrders, setMyOrders] = useState<EmailOrder[] | null>(null);

  const [active, setActive] = useState<StorefrontProduct | null>(null);
  const [specId, setSpecId] = useState("");
  const [qty, setQty] = useState(1);
  const [buyerEmail, setBuyerEmail] = useState("");
  const [channel, setChannel] = useState<Channel>(channels[0] || "alipay");
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyError, setBuyError] = useState("");

  const t = I18N[lang];
  const products = config.products;
  const maxQty = Math.max(1, Math.trunc(maxQuantity) || 1);
  const live = Boolean(slug) && !preview;
  const brandLetter = (config.logoLetter || config.shopName.trim().charAt(0) || "K").toUpperCase();
  const multiLang = config.languages.length > 1;

  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    products.forEach((item) => {
      if (item.category !== "all") seen.set(item.category, item.categoryLabel);
    });
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [products]);

  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return products.filter((item) => {
      const inCategory = filter === "all" || item.category === filter;
      const inKeyword =
        !kw ||
        item.name.zh.toLowerCase().includes(kw) ||
        item.name.en.toLowerCase().includes(kw) ||
        item.desc.zh.toLowerCase().includes(kw);
      return inCategory && inKeyword;
    });
  }, [products, filter, keyword]);

  const activeSpec = active?.specs.find((spec) => spec.id === specId) ?? active?.specs[0] ?? null;
  const totalCents = activeSpec ? activeSpec.priceCents * qty : 0;
  const specMaxQty = Math.min(maxQty, activeSpec?.stock ?? maxQty);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("kaimi-store-email") || "";
      if (saved) {
        setQueryEmail(saved);
        setBuyerEmail(saved);
      }
    } catch {
      /* sessionStorage 不可用时忽略 */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setActive(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  function jump(id: "home" | "products" | "query" | "contact") {
    setNav(id);
    const wasDetail = Boolean(active);
    if (wasDetail) setActive(null);
    requestAnimationFrame(() => {
      const target = document.getElementById(id === "home" ? "km-sf-top" : `km-sf-${id}`);
      target?.scrollIntoView({ behavior: wasDetail ? "auto" : "smooth", block: "start" });
    });
  }

  function openProduct(product: StorefrontProduct) {
    setActive(product);
    setSpecId(product.specs[0]?.id ?? "");
    setQty(1);
    setBuyError("");
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  async function lookupOrders() {
    const email = queryEmail.trim();
    if (!email) {
      setQueryError(t.queryDesc);
      return;
    }
    if (!live) {
      setQueryError(t.detail.previewNote);
      return;
    }
    setQueryBusy(true);
    setQueryError("");
    try {
      window.sessionStorage.setItem("kaimi-store-email", email);
      const data = await readApiJson<{ list?: EmailOrder[] }>(
        await fetch(
          `/api/public/store-orders?slug=${encodeURIComponent(slug)}&email=${encodeURIComponent(email)}`,
          { cache: "no-store" },
        ),
      );
      const list = data.list || [];
      setMyOrders(list);
      if (!list.length) setQueryError(t.queryEmpty);
    } catch (reason) {
      setMyOrders(null);
      setQueryError(reason instanceof Error ? reason.message : "查单失败");
    } finally {
      setQueryBusy(false);
    }
  }

  async function buy() {
    if (!activeSpec) return;
    const email = buyerEmail.trim();
    if (!email) {
      setBuyError(t.detail.emailRequired);
      return;
    }
    if (live && !channels.length) {
      setBuyError(t.detail.channelEmpty);
      return;
    }
    if (!live) {
      setBuyError(t.detail.previewNote);
      return;
    }
    setBuyBusy(true);
    setBuyError("");
    try {
      window.sessionStorage.setItem("kaimi-store-email", email);
      const data = await readApiJson<{
        orderNo?: string;
        queryToken?: string;
        payUrl?: string;
      }>(
        await fetch("/api/public/store-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            planKey: activeSpec.id,
            channel,
            customerEmail: email,
            quantity: qty,
          }),
        }),
      );
      if (data.orderNo && data.queryToken) {
        window.sessionStorage.setItem(`kaimi-order-token:${data.orderNo}`, data.queryToken);
        window.sessionStorage.setItem(
          "kaimi-last-store-order",
          JSON.stringify({
            orderNo: data.orderNo,
            token: data.queryToken,
            createdAt: new Date().toISOString(),
          }),
        );
      }
      if (!data.payUrl) throw new Error("未拿到支付链接，请稍后重试");
      window.location.href = data.payUrl;
    } catch (reason) {
      setBuyError(reason instanceof Error ? reason.message : "下单失败");
      setBuyBusy(false);
    }
  }

  const heroChip = pickText(config.hero.chip, lang, PLATFORM_HERO.chip);
  const heroTitle = pickText(config.hero.title, lang, PLATFORM_HERO.title);
  const heroSub = pickText(config.hero.sub, lang, PLATFORM_HERO.sub);
  const slogan = pickText(config.slogan, lang, PLATFORM_SLOGAN);
  const announcement = pickText(config.announcement.text, lang);

  const NAV_ITEMS = [
    { id: "home", label: t.nav.home, show: true },
    { id: "query", label: t.nav.query, show: config.queryEnabled },
    { id: "contact", label: t.nav.contact, show: config.contacts.length > 0 },
  ].filter((item) => item.show);

  return (
    <div data-theme={themeId} className={`km-sf km-themed-page${preview ? " is-preview" : ""}`}>
      <ApplyTheme themeId={themeId} />
      <div className="km-sf-sticky">
        {preview ? (
          <div className="km-sf-preview-bar">
            <p>{t.previewTip}</p>
            <div className="km-sf-preview-swatches">
              {THEME_CHOICES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  data-theme={theme.id}
                  className="km-sf-preview-swatch"
                  aria-pressed={themeId === theme.id}
                  onClick={() => setThemeId(theme.id)}
                >
                  <span className="km-theme-dot" aria-hidden />
                  {theme.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <header className="km-sf-header">
          <div className="km-shell-wide km-sf-header-inner">
            <a href="#km-sf-top" className="km-brand min-w-0">
              <span className="km-sf-brand-mark grid place-items-center" aria-hidden>
                {brandLetter}
              </span>
              <span className="km-brand-name">{config.shopName}</span>
            </a>
            <nav className="km-sf-nav-pill" aria-label="店铺导航">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`km-sf-nav-item${nav === item.id ? " km-sf-nav-item-active" : ""}`}
                  onClick={() => jump(item.id as "home" | "products" | "query" | "contact")}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="km-sf-tools">
              {config.queryEnabled ? (
                <button
                  type="button"
                  className="km-sf-icon-btn"
                  aria-label={t.nav.query}
                  onClick={() => jump("query")}
                >
                  <IconOrders />
                </button>
              ) : null}
              {multiLang ? (
                <button
                  type="button"
                  className="km-sf-lang"
                  aria-label="切换语言 / Switch language"
                  onClick={() => setLang(lang === "zh" ? "en" : "zh")}
                >
                  <IconGlobe />
                  <span>{t.langLabel}</span>
                </button>
              ) : null}
            </div>
          </div>
        </header>

        {config.announcement.enabled && announcement ? (
          <div className="km-sf-announce">
            <IconMegaphone />
            <span>{announcement}</span>
          </div>
        ) : null}
      </div>

      <div id="km-sf-top" className="km-shell-wide space-y-10 py-8 md:py-10">
        {!active || !activeSpec ? (
          <>
            {config.hero.enabled ? (
              <section className="km-sf-hero2 km-rise">
                {heroChip ? <span className="km-sf-chip">{heroChip}</span> : null}
                <h1 className="km-sf-hero-title">{heroTitle}</h1>
                {heroSub ? <p className="km-sf-hero-sub">{heroSub}</p> : null}
                {config.searchEnabled ? (
                  <label className="km-sf-search">
                    <IconSearch />
                    <input
                      value={keyword}
                      onChange={(event) => setKeyword(event.target.value)}
                      placeholder={t.searchPlaceholder}
                      aria-label={t.searchPlaceholder}
                    />
                  </label>
                ) : null}
                {config.stats.enabled && config.stats.items.length ? (
                  <div className="km-sf-stats">
                    {config.stats.items.map((stat, index) => (
                      <div key={`${stat.value}-${index}`} className="km-sf-stat">
                        <strong>{stat.value}</strong>
                        <span>{pickText(stat.label, lang)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {config.queryEnabled ? (
              <section id="km-sf-query" className="km-sf-query">
                <div className="km-sf-query-icon" aria-hidden>
                  <IconMail />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <h2 className="km-sf-query-title">{t.queryTitle}</h2>
                  <p className="km-sf-query-desc">{t.queryDesc}</p>
                  <div className="km-sf-query-row">
                    <input
                      className="km-input"
                      type="email"
                      value={queryEmail}
                      onChange={(event) => setQueryEmail(event.target.value)}
                      placeholder={t.queryPlaceholder}
                      aria-label={t.queryTitle}
                    />
                    <button
                      type="button"
                      className="km-btn km-btn-sm"
                      disabled={queryBusy || !queryEmail.trim()}
                      onClick={() => void lookupOrders()}
                    >
                      {queryBusy ? t.queryBusy : t.queryButton}
                    </button>
                  </div>
                  <p className="km-sf-query-note">{queryError || t.queryNote}</p>
                  {myOrders?.length ? (
                    <div className="km-sf-orders">
                      <p className="km-sf-query-note">{t.queryScope}</p>
                      {myOrders.map((order) => (
                        <a
                          key={order.orderNo}
                          className="km-sf-order-row"
                          href={
                            order.queryToken
                              ? `/shop/order/${encodeURIComponent(order.orderNo)}?qt=${encodeURIComponent(order.queryToken)}`
                              : `/shop/order/${encodeURIComponent(order.orderNo)}`
                          }
                        >
                          <span className="min-w-0">
                            <strong>{order.productName}</strong>
                            <em>{order.orderNo}</em>
                            <span>
                              {publicStatusLabel(order.payStatus, "pay")} ·{" "}
                              {publicStatusLabel(order.fulfillStatus, "fulfill")}
                              {(order.quantity || 1) > 1 ? ` · ${order.quantity} 张` : ""}
                            </span>
                          </span>
                          <span className="km-sf-order-amount">
                            ¥{yuanTextFromCents(order.amountCents)}
                          </span>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            <section id="km-sf-products" className="space-y-4">
              {categories.length > 1 ? (
                <div className="km-sf-filters km-sf-filters-solo" role="tablist" aria-label="商品分类">
                  <button
                    type="button"
                    className={`km-tab${filter === "all" ? " km-tab-active" : ""}`}
                    onClick={() => setFilter("all")}
                  >
                    {t.allCategory}
                  </button>
                  {categories.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`km-tab${filter === item.id ? " km-tab-active" : ""}`}
                      onClick={() => setFilter(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}

              {visible.length ? (
                <div className="km-sf-grid2">
                  {visible.map((product) => {
                    const minCents = Math.min(...product.specs.map((spec) => spec.priceCents));
                    return (
                      <button
                        key={product.id}
                        type="button"
                        className="km-sf-card2"
                        onClick={() => openProduct(product)}
                      >
                        <div className="km-sf-card2-top">
                          <ProductIcon product={product} />
                          <div className="km-sf-tags">
                            {product.tags.map((tag) => (
                              <span key={tag.en} className="km-sf-tag">
                                {pickText(tag, lang)}
                              </span>
                            ))}
                          </div>
                        </div>
                        <h3 className="km-sf-card2-title">{pickText(product.name, lang)}</h3>
                        <p className="km-sf-card2-sub">{pickText(product.subtitle, lang)}</p>
                        <div className="km-sf-card2-foot">
                          <span className="km-sf-price2">
                            {product.specs.length > 1
                              ? t.priceFrom(yuanTextFromCents(minCents))
                              : `¥${yuanTextFromCents(minCents)}`}
                          </span>
                          <span className="km-sf-stock">
                            {product.stock === null ? t.inStockShort : t.stock(product.stock)}
                          </span>
                        </div>
                        <span className="km-sf-buy">
                          {t.buyNow}
                          <IconArrow />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="km-sf-empty">{t.empty}</p>
              )}
            </section>
          </>
        ) : (
          <>
            <nav className="km-sf-crumb" aria-label="面包屑">
              <button type="button" onClick={() => jump("home")}>
                {t.detail.crumbHome}
              </button>
              <span aria-hidden>/</span>
              <button type="button" onClick={() => jump("products")}>
                {t.detail.crumbProducts}
              </button>
              <span aria-hidden>/</span>
              <span className="km-sf-crumb-now">{pickText(active.name, lang)}</span>
            </nav>

            <section className="km-sf-detail km-rise">
              <div className="km-sf-detail-art">
                <ProductBanner product={active} lang={lang} />

                <div className="km-sf-info">
                  <h2 className="km-sf-info-title">{t.detail.infoTitle}</h2>
                  {active.detail.map((section) => (
                    <div key={section.title.en} className="km-sf-info-sec">
                      <h3 className="km-sf-info-sec-title">
                        <span aria-hidden>{section.icon}</span>
                        {pickText(section.title, lang)}
                      </h3>
                      {section.lines.map((line, index) => (
                        <p key={`${section.title.en}-${index}`} className="km-sf-info-line">
                          {line.label ? <strong>{pickText(line.label, lang)}：</strong> : null}
                          {line.link ? (
                            <a href={line.link} target="_blank" rel="noreferrer">
                              {pickText(line.text, lang)}
                            </a>
                          ) : (
                            pickText(line.text, lang)
                          )}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              <div className="km-sf-detail-panel">
                {active.categoryLabel ? (
                  <p className="km-sf-detail-cat">
                    {t.detail.category} · {active.categoryLabel}
                  </p>
                ) : null}
                <h1 className="km-sf-detail-title">{pickText(active.name, lang)}</h1>

                <div className="km-sf-badges">
                  {active.tags.map((tag) => (
                    <span key={tag.en} className="km-sf-badge">
                      {pickText(tag, lang)}
                    </span>
                  ))}
                  <span className="km-sf-badge">{t.detail.inStock}</span>
                </div>

                <p className="km-sf-detail-desc">{pickText(active.desc, lang)}</p>

                <p className="km-sf-field-label km-sf-field-label-sep">{t.detail.priceLabel}</p>
                <p className="km-sf-detail-price">
                  {yuanTextFromCents(totalCents)} <small>CNY</small>
                </p>

                {active.specs.length ? (
                  <>
                    <p className="km-sf-field-label">{t.detail.chooseSpec}</p>
                    <div className="km-sf-spec-list">
                      {active.specs.map((spec) => {
                        const selected = spec.id === activeSpec.id;
                        return (
                          <button
                            key={spec.id}
                            type="button"
                            className={`km-sf-spec-row${selected ? " km-sf-spec-row-active" : ""}`}
                            aria-pressed={selected}
                            onClick={() => {
                              setSpecId(spec.id);
                              setQty(1);
                            }}
                          >
                            <span className="km-sf-spec-row-main">
                              <span className="km-sf-spec-row-name">{pickText(spec.name, lang)}</span>
                              <span className="km-sf-spec-row-stock">
                                {spec.stock === null ? t.detail.inStock : t.detail.stock(spec.stock)}
                              </span>
                            </span>
                            <span className="km-sf-spec-row-right">
                              {spec.auto ? (
                                <em className="km-sf-spec-auto">
                                  <IconBolt />
                                  {t.detail.auto}
                                </em>
                              ) : null}
                              <span className="km-sf-spec-price">
                                ¥{yuanTextFromCents(spec.priceCents)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}

                <div className="km-sf-buybox">
                  {specMaxQty > 1 ? (
                    <>
                      <p className="km-sf-field-label">{t.detail.qty}</p>
                      <div className="km-sf-qty-row">
                        <div className="km-sf-qty">
                          <button
                            type="button"
                            aria-label="减少数量"
                            disabled={qty <= 1}
                            onClick={() => setQty((value) => Math.max(1, value - 1))}
                          >
                            −
                          </button>
                          <span>{qty}</span>
                          <button
                            type="button"
                            aria-label="增加数量"
                            disabled={qty >= specMaxQty}
                            onClick={() => setQty((value) => Math.min(specMaxQty, value + 1))}
                          >
                            ＋
                          </button>
                        </div>
                        <span className="km-sf-qty-hint">{t.detail.qtyMax(specMaxQty)}</span>
                      </div>
                    </>
                  ) : null}

                  <p className="km-sf-field-label">{t.detail.email}</p>
                  <input
                    className="km-input"
                    type="email"
                    value={buyerEmail}
                    onChange={(event) => setBuyerEmail(event.target.value)}
                    placeholder={t.queryPlaceholder}
                  />
                  <p className="km-sf-modal-hint">{t.detail.emailHint}</p>

                  <p className="km-sf-field-label">{t.detail.channel}</p>
                  {channels.length ? (
                    <div className="km-sf-channels" role="radiogroup" aria-label={t.detail.channel}>
                      {channels.map((item) => (
                        <button
                          key={item}
                          type="button"
                          role="radio"
                          aria-checked={channel === item}
                          data-channel={item}
                          className={`km-sf-channel${channel === item ? " km-sf-channel-active" : ""}`}
                          onClick={() => setChannel(item)}
                        >
                          {CHANNEL_LABEL[item][lang]}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="km-sf-modal-hint">{t.detail.channelEmpty}</p>
                  )}

                  {buyError ? <p className="km-sf-error">{buyError}</p> : null}

                  <button
                    type="button"
                    className="km-btn km-sf-detail-buy"
                    disabled={buyBusy}
                    onClick={() => void buy()}
                  >
                    {buyBusy
                      ? t.detail.payBusy
                      : `${t.detail.pay} · ¥${yuanTextFromCents(totalCents)}`}
                  </button>

                  <p className="km-sf-secure">
                    <IconLock />
                    {t.detail.secure}
                  </p>
                </div>
              </div>
            </section>

            <div className="km-sf-back-row">
              <button type="button" className="km-sf-back" onClick={() => jump("products")}>
                <IconBack />
                {t.detail.back}
              </button>
            </div>
          </>
        )}

        <footer id="km-sf-contact" className="space-y-6 pb-8 pt-4">
          <div className="km-sf-footer">
            <div className="space-y-3">
              <div className="km-brand">
                <span className="km-sf-brand-mark grid place-items-center" aria-hidden>
                  {brandLetter}
                </span>
                <span className="km-brand-name">{config.shopName}</span>
              </div>
              <p className="max-w-sm text-sm leading-6 text-[var(--km-fg-muted)]">{slogan}</p>
            </div>
            <div>
              <h3>{t.footerLinks}</h3>
              {config.queryEnabled ? (
                <button type="button" onClick={() => jump("query")}>
                  {t.nav.query}
                </button>
              ) : null}
              <button type="button" onClick={() => jump("products")}>
                {t.nav.products}
              </button>
            </div>
            {config.contacts.length ? (
              <div>
                <h3>{t.footerContact}</h3>
                {config.contacts.map((contact, index) => {
                  const href = contactHref(contact);
                  const label = pickText(contact.label, lang, contactFallbackLabel(contact.type));
                  const inner = (
                    <>
                      <ContactIcon type={contact.type} />
                      <span>
                        {label}：{contact.value}
                      </span>
                    </>
                  );
                  const key = `${contact.type}-${index}`;
                  return href ? (
                    <a key={key} className="km-sf-contact" href={href} target="_blank" rel="noreferrer">
                      {inner}
                    </a>
                  ) : (
                    <span key={key} className="km-sf-contact">
                      {inner}
                    </span>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="km-sf-legal">
            <span>
              © {new Date().getFullYear()} {config.shopName}. {t.rights}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
