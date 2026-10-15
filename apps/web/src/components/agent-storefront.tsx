"use client";

import { useEffect, useMemo, useState } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import { readApiJson } from "@/lib/http-error";
import { contactHref } from "@/lib/agent-contact-core";
import { RegionBadge } from "@/components/region-badge";
import { regionDisplay } from "@/lib/cardplatform/regions";
import { invoiceSurchargeCents } from "@/lib/invoice-core";
import { yuanTextFromCents } from "@/lib/money";
import { THEME_CHOICES } from "@/lib/themes";
import {
  PLATFORM_HERO,
  PLATFORM_SLOGAN,
  pickText,
  type Lang,
  type StorefrontConfig,
  type StorefrontProduct,
} from "@/lib/agent-storefront-config";
import {
  DEFAULT_AGENT_REDEEM_URL,
  isExternalRedeemUrl,
} from "@/lib/agent-redeem-core";
import { isThemeId, type ThemeId } from "@kaimi/themes";
import { StorefrontEmailLookup } from "@/components/storefront-email-lookup";
import { I18N } from "@/components/storefront-i18n";
import {
  ContactIcon,
  CoverPhoto,
  IconArrow,
  IconBack,
  IconBolt,
  IconGlobe,
  IconLock,
  IconMegaphone,
  IconSearch,
  ProductBanner,
  ProductIcon,
  contactFallbackLabel,
} from "@/components/storefront-visuals";

type Channel = "alipay" | "wxpay";

function productAvailable(product: StorefrontProduct) {
  return product.available !== false;
}

function productAvailabilityLabel(
  product: StorefrontProduct,
  t: {
    restocking: string;
    inStockAccount: string;
    inStockShort: string;
    stock: (n: number) => string;
  },
) {
  if (!productAvailable(product)) return t.restocking;
  if (product.kind === "account") return t.inStockAccount;
  return product.stock === null ? t.inStockShort : t.stock(product.stock);
}

const CHANNEL_LABEL: Record<Channel, { zh: string; en: string }> = {
  alipay: { zh: "支付宝", en: "Alipay" },
  wxpay: { zh: "微信支付", en: "WeChat Pay" },
};

/* ———————————————————————————— 主组件 ———————————————————————————— */

export function AgentStorefront({
  config,
  preview = false,
  slug = "",
  channels = [],
  maxQuantity = 5,
  redeemUrl = DEFAULT_AGENT_REDEEM_URL,
}: {
  config: StorefrontConfig;
  /** 预览模式：显示主题色板、不真的下单 */
  preview?: boolean;
  slug?: string;
  channels?: Channel[];
  maxQuantity?: number;
  redeemUrl?: string;
}) {
  const [themeId, setThemeId] = useState<ThemeId>(
    isThemeId(config.themeId) ? config.themeId : "snow",
  );
  const [lang, setLang] = useState<Lang>(config.defaultLang);
  const [nav, setNav] = useState<"home" | "products" | "query" | "contact">("products");
  const [filter, setFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("");
  const [regionSwitchNote, setRegionSwitchNote] = useState("");
  const [keyword, setKeyword] = useState("");

  const [active, setActive] = useState<StorefrontProduct | null>(null);
  const [specId, setSpecId] = useState("");
  const [qty, setQty] = useState(1);
  const [buyerEmail, setBuyerEmail] = useState("");
  const [channel, setChannel] = useState<Channel>(channels[0] || "alipay");
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyError, setBuyError] = useState("");
  const [regionConfirmed, setRegionConfirmed] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [wantInvoice, setWantInvoice] = useState(false);
  const [invoiceTitle, setInvoiceTitle] = useState("");
  const [invoiceTaxNo, setInvoiceTaxNo] = useState("");
  const [invoiceNote, setInvoiceNote] = useState("");
  const [invoiceEmail, setInvoiceEmail] = useState("");
  const [invoiceEmailTouched, setInvoiceEmailTouched] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [couponQuote, setCouponQuote] = useState<{
    goodsCents: number;
    discountCents: number;
    listGoodsCents: number;
  } | null>(null);
  const [couponError, setCouponError] = useState("");
  const [couponChecking, setCouponChecking] = useState(false);
  const [couponKind, setCouponKind] = useState("");
  /** 邀请链接 ?ref= 带来的、或买家手填的邀请码。 */
  const [referralCode, setReferralCode] = useState("");
  const [referralFromLink, setReferralFromLink] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [referralInput, setReferralInput] = useState("");
  const [referralInvalid, setReferralInvalid] = useState(false);

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

  // 只有一个分类且没有未分类商品时，分类栏等于「全部」，没必要占一行。
  // 但一个分类 + 一批未分类商品是能筛的，这时候要显示。
  const showCategories =
    categories.length > 1 ||
    (categories.length === 1 && products.some((item) => item.category === "all"));

  const regionOptions = useMemo(() => {
    const seen = new Map<string, { country: string; code: string; zh: string; en: string }>();
    for (const product of products) {
      for (const spec of product.specs) {
        if (!spec.region) continue;
        const key = spec.region.code.toLowerCase();
        if (!seen.has(key)) seen.set(key, spec.region);
      }
    }
    return [...seen.values()];
  }, [products]);
  const showRegions = regionOptions.length >= 2;

  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return products.filter((item) => {
      const inCategory = filter === "all" || item.category === filter;
      const inRegion =
        !regionFilter ||
        item.specs.some((spec) => spec.region?.code.toLowerCase() === regionFilter);
      const inKeyword =
        !kw ||
        item.name.zh.toLowerCase().includes(kw) ||
        item.name.en.toLowerCase().includes(kw) ||
        item.desc.zh.toLowerCase().includes(kw);
      return inCategory && inRegion && inKeyword;
    });
  }, [products, filter, keyword, regionFilter]);

  // 卡密和成品账号拿到手之后的用法完全不同，分开摆。只卖一类时不出组标题。
  const sellsCodes = products.some((item) => item.kind !== "account");
  const sellsAccounts = products.some((item) => item.kind === "account");
  const productGroups = useMemo(
    () =>
      [
        { id: "cdk" as const, items: visible.filter((item) => item.kind !== "account") },
        { id: "account" as const, items: visible.filter((item) => item.kind === "account") },
      ].filter((group) => group.items.length),
    [visible],
  );
  // 首屏示意卡用店里第一个卡密商品的真名和价格，买家一眼看到的就是真东西。
  const ticketProduct = products.find((item) => item.kind !== "account") ?? null;
  const ticketSpec = ticketProduct?.specs[0] ?? null;

  const activeSpec = active?.specs.find((spec) => spec.id === specId) ?? active?.specs[0] ?? null;
  const listGoodsCents = activeSpec ? activeSpec.priceCents * qty : 0;
  const goodsCents =
    couponQuote && couponQuote.discountCents > 0 ? couponQuote.goodsCents : listGoodsCents;
  const surchargeCents = wantInvoice && goodsCents > 0 ? invoiceSurchargeCents(goodsCents) : 0;
  const totalCents = goodsCents + surchargeCents;
  const specMaxQty = Math.min(maxQty, activeSpec?.stock ?? maxQty);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("kaimi-store-email") || "";
      if (saved) setBuyerEmail(saved);
    } catch {
      /* sessionStorage 不可用时忽略 */
    }
    const params = new URLSearchParams(window.location.search);
    // 邀请码按店铺记 30 天：好友点了链接，过几天再回来买也算
    const refKey = `km-sf-ref:${slug}`;
    const refFromUrl = (params.get("ref") || "").trim().toUpperCase();
    try {
      if (/^[A-Z0-9]{4,16}$/.test(refFromUrl)) {
        window.localStorage.setItem(refKey, JSON.stringify({ code: refFromUrl, at: Date.now() }));
      }
      const saved = JSON.parse(window.localStorage.getItem(refKey) || "null") as { code?: string; at?: number } | null;
      if (saved?.code && Date.now() - Number(saved.at || 0) < 30 * 86_400_000) {
        setReferralCode(saved.code);
        setReferralFromLink(true);
      } else if (saved) {
        window.localStorage.removeItem(refKey);
      }
    } catch {
      /* localStorage 不可用时只在这次页面里用 */
      if (/^[A-Z0-9]{4,16}$/.test(refFromUrl)) {
        setReferralCode(refFromUrl);
        setReferralFromLink(true);
      }
    }
    const fromUrl = (params.get("region") || "").trim().toLowerCase();
    let stored = "";
    try {
      stored = window.localStorage.getItem(`km-sf-region:${slug}`) || "";
    } catch {
      stored = "";
    }
    const initial = fromUrl || stored;
    if (initial && products.some((product) => product.specs.some((spec) => spec.region?.code.toLowerCase() === initial))) {
      setRegionFilter(initial);
    }
    const plan = (params.get("plan") || "").trim();
    if (!plan) return;
    const product = products.find(
      (item) => item.id === plan || item.specs.some((spec) => spec.id === plan),
    );
    if (!product) return;
    const spec = product.specs.find((item) => item.id === plan);
    setActive(product);
    setNav("products");
    if (spec) {
      setSpecId(spec.id);
      return;
    }
    const fallback = product.specs.find((item) => item.region?.code === "PH") ?? product.specs[0];
    setSpecId(fallback?.id ?? "");
    const missing = regionDisplay(plan.includes(":") ? plan.split(":")[1] : "");
    const landed = fallback?.region;
    const useEn = config.defaultLang === "en";
    if (landed) {
      setRegionSwitchNote(
        I18N[config.defaultLang].detail.regionSwitched(
          useEn ? missing.en : missing.zh,
          useEn ? landed.en : landed.zh,
        ),
      );
    }
  }, [products, slug, config.defaultLang]);

  useEffect(() => {
    if (!invoiceEmailTouched) setInvoiceEmail(buyerEmail);
  }, [buyerEmail, invoiceEmailTouched]);

  useEffect(() => {
    const code = couponCode.trim();
    if (!live || !activeSpec || !code) {
      setCouponQuote(null);
      setCouponError("");
      setCouponChecking(false);
      return;
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        setCouponChecking(true);
        try {
          const data = await readApiJson<{
            goodsCents: number;
            discountCents: number;
            listGoodsCents: number;
            couponKind?: string;
          }>(
            await fetch("/api/public/store-orders/quote", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                slug,
                planKey: activeSpec.id,
                channel,
                quantity: qty,
                couponCode: code,
                // 邀请券只能本人用，要带上邮箱核对
                customerEmail: buyerEmail.trim() || undefined,
              }),
            }),
          );
          setCouponQuote(data);
          setCouponKind(data.couponKind || "");
          setCouponError("");
        } catch (reason) {
          setCouponQuote(null);
          setCouponError(reason instanceof Error ? reason.message : "优惠券无效");
        } finally {
          setCouponChecking(false);
        }
      })();
    }, 350);
    return () => window.clearTimeout(handle);
  }, [live, slug, activeSpec, couponCode, channel, qty, buyerEmail]);

  useEffect(() => {
    if (!active && !invoiceOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (invoiceOpen) {
        if (!buyBusy) setInvoiceOpen(false);
        return;
      }
      setActive(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, invoiceOpen, buyBusy]);

  async function checkReferralInput() {
    const code = referralInput.trim().toUpperCase();
    if (!code) return;
    try {
      const data = await readApiJson<{ valid: boolean }>(
        await fetch(`/api/public/referral-codes?slug=${encodeURIComponent(slug)}&code=${encodeURIComponent(code)}`, {
          cache: "no-store",
        }),
      );
      if (data.valid) {
        setReferralCode(code);
        setReferralFromLink(false);
      } else {
        setReferralInvalid(true);
      }
    } catch {
      setReferralInvalid(true);
    }
  }

  function jump(id: "home" | "products" | "query" | "contact") {
    setNav(id);
    const wasDetail = Boolean(active);
    if (wasDetail) setActive(null);
    requestAnimationFrame(() => {
      const target = document.getElementById(id === "home" ? "km-sf-top" : `km-sf-${id}`);
      target?.scrollIntoView({ behavior: wasDetail ? "auto" : "smooth", block: "start" });
    });
  }

  function chooseRegion(code: string) {
    setRegionFilter(code);
    const key = `km-sf-region:${slug || "preview"}`;
    try {
      if (code) window.localStorage.setItem(key, code);
      else window.localStorage.removeItem(key);
    } catch {
      /* 记住失败不影响筛选 */
    }
    const url = new URL(window.location.href);
    if (code) url.searchParams.set("region", code);
    else url.searchParams.delete("region");
    window.history.replaceState(null, "", url);
  }

  function specForProduct(product: StorefrontProduct, preferred = "") {
    if (preferred) {
      const exact = product.specs.find((spec) => spec.id === preferred);
      if (exact) return exact.id;
    }
    if (regionFilter) {
      const matched = product.specs.find(
        (spec) => spec.region?.code.toLowerCase() === regionFilter,
      );
      if (matched) return matched.id;
    }
    return (
      product.specs.find((spec) => spec.region?.code === "PH")?.id ??
      product.specs[0]?.id ??
      ""
    );
  }

  function openProduct(product: StorefrontProduct) {
    setActive(product);
    setSpecId(specForProduct(product));
    setQty(1);
    setRegionSwitchNote("");
    setRegionConfirmed(false);
    setBuyError("");
    setInvoiceOpen(false);
    setWantInvoice(false);
    setCouponCode("");
    setCouponQuote(null);
    setCouponError("");
    setInvoiceTitle("");
    setInvoiceTaxNo("");
    setInvoiceNote("");
    setInvoiceEmailTouched(false);
    setInvoiceEmail(buyerEmail);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function openInvoicePrompt() {
    if (!activeSpec) return;
    if (active && !productAvailable(active)) {
      setBuyError(t.detail.restockingHint);
      return;
    }
    if (!buyerEmail.trim()) {
      setBuyError(t.detail.emailRequired);
      return;
    }
    if (live && !channels.length) {
      setBuyError(t.detail.channelEmpty);
      return;
    }
    setBuyError("");
    setWantInvoice(false);
    setInvoiceTitle("");
    setInvoiceTaxNo("");
    setInvoiceNote("");
    setInvoiceEmailTouched(false);
    setInvoiceEmail(buyerEmail);
    setInvoiceOpen(true);
  }

  async function buy() {
    if (!activeSpec) return;
    const email = buyerEmail.trim();
    if (!email) {
      setBuyError(t.detail.emailRequired);
      setInvoiceOpen(false);
      return;
    }
    if (wantInvoice) {
      if (!invoiceTitle.trim()) {
        setBuyError(t.detail.invoiceTitleRequired);
        return;
      }
      const taxNo = invoiceTaxNo.trim().toUpperCase();
      if (!taxNo) {
        setBuyError(t.detail.invoiceTaxNoRequired);
        return;
      }
      if (!/^[0-9A-Z]{15,20}$/.test(taxNo)) {
        setBuyError(t.detail.invoiceTaxNoInvalid);
        return;
      }
      if (!invoiceNote.trim()) {
        setBuyError(t.detail.invoiceNoteRequired);
        return;
      }
      if (!invoiceEmail.trim()) {
        setBuyError(t.detail.invoiceEmailRequired);
        return;
      }
    }
    if (live && !channels.length) {
      setBuyError(t.detail.channelEmpty);
      return;
    }
    const regionChoices = (active?.specs ?? []).filter((spec) => spec.region).length;
    if (regionChoices >= 2 && !regionConfirmed) {
      setBuyError(t.detail.regionConfirmRequired);
      return;
    }
    if (couponCode.trim() && (couponChecking || couponError || !couponQuote)) {
      setBuyError(couponError || t.detail.couponChecking);
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
            invoiceRequested: wantInvoice,
            invoiceTitle: wantInvoice ? invoiceTitle.trim() : undefined,
            invoiceTaxNo: wantInvoice ? invoiceTaxNo.trim() : undefined,
            invoiceNote: wantInvoice ? invoiceNote.trim() : undefined,
            invoiceEmail: wantInvoice ? invoiceEmail.trim() : undefined,
            couponCode: couponCode.trim() || undefined,
            regionConfirmed: regionChoices >= 2 ? regionConfirmed : undefined,
            referralCode: referralCode || undefined,
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
    { id: "products", label: t.nav.products, show: true },
    { id: "query", label: t.nav.query, show: config.queryEnabled },
    { id: "contact", label: t.nav.contact, show: config.contacts.length > 0 },
  ].filter((item) => item.show);

  /** 商品卡片：沿用原来的样子，分组后每组都用它。 */
  function renderProductCard(product: StorefrontProduct) {
    const matched = regionFilter
      ? product.specs.find((spec) => spec.region?.code.toLowerCase() === regionFilter)
      : null;
    const minCents = matched
      ? matched.priceCents
      : Math.min(...product.specs.map((spec) => spec.priceCents));
    const badges = product.specs.filter((spec) => spec.region);
    const shownBadges = matched ? badges.filter((spec) => spec.id === matched.id) : badges;
    return (
      <button
        key={product.id}
        type="button"
        className="km-sf-card2"
        onClick={() => openProduct(product)}
      >
        <div
          className="km-sf-card2-art"
          style={
            product.cover
              ? undefined
              : { background: `hsl(${product.hue} 18% 96%)` }
          }
        >
          <CoverPhoto
            src={product.cover}
            fallback={<ProductIcon product={product} />}
          />
        </div>
        <div className="km-sf-card2-body">
          <div className="km-sf-card2-top">
            <span className="km-sf-card2-kicker">
              {product.categoryLabel || pickText(product.subtitle, lang)}
            </span>
            <span
              className={`km-sf-stock${productAvailable(product) ? "" : " km-sf-stock-wait"}`}
            >
              {productAvailabilityLabel(product, t)}
            </span>
          </div>
          <h3 className="km-sf-card2-title">{pickText(product.name, lang)}</h3>
          {shownBadges.length ? (
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {shownBadges.slice(0, 4).map((spec) => (
                <RegionBadge
                  key={spec.id}
                  country={spec.region?.country || ""}
                  regionLabel={spec.region?.zh}
                  compact
                />
              ))}
            </span>
          ) : null}
          <div className="km-sf-card2-foot">
            <span className="km-sf-price2">
              {!matched && product.specs.length > 1
                ? t.priceFrom(yuanTextFromCents(minCents))
                : `¥${yuanTextFromCents(minCents)}`}
            </span>
            <span className="km-sf-buy">
              {productAvailable(product) ? t.buyNow : t.restocking}
              <IconArrow />
            </span>
          </div>
        </div>
      </button>
    );
  }

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
              <a
                href={redeemUrl}
                className="km-sf-nav-item km-sf-nav-redeem"
                {...(isExternalRedeemUrl(redeemUrl)
                  ? { target: "_blank", rel: "noreferrer" }
                  : undefined)}
              >
                {t.nav.redeem}
              </a>
            </nav>
            <div className="km-sf-tools">
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

      <div id="km-sf-top" className="km-shell-wide space-y-12 py-6 md:py-8">
        {!active || !activeSpec ? (
          <>
            <section className="km-sf-intro km-rise">
              <div className="km-sf-intro-main">
                {config.hero.enabled && heroChip ? <span className="km-sf-chip">{heroChip}</span> : null}
                <h1 className="km-sf-intro-title">{config.hero.enabled ? heroTitle : config.shopName}</h1>
                <p className="km-sf-intro-sub">{config.hero.enabled ? heroSub : slogan}</p>
                <ol className="km-sf-steps" aria-label={t.stepsLabel}>
                  {(sellsCodes ? t.steps : t.stepsAccount).map((step, index) => (
                    <li key={step.title}>
                      <span className="km-sf-step-no" aria-hidden>
                        {index + 1}
                      </span>
                      <b>{step.title}</b>
                      <span>{step.desc}</span>
                    </li>
                  ))}
                </ol>
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
              </div>
              {ticketProduct && ticketSpec ? (
                <div className="km-sf-ticket" tabIndex={0} aria-label={t.ticketLabel}>
                  <div className="km-sf-ticket-head">
                    <span>{config.shopName}</span>
                    <span className="km-sf-ticket-badge">{t.ticketBadge}</span>
                  </div>
                  <p className="km-sf-ticket-plan">
                    {pickText(ticketProduct.name, lang)}
                    {ticketSpec.region ? ` · ${lang === "en" ? ticketSpec.region.en : ticketSpec.region.zh}` : ""}
                    <span>¥{yuanTextFromCents(ticketSpec.priceCents)}</span>
                  </p>
                  <div className="km-sf-scratch" aria-hidden>
                    ZC-XXXX-XXXX-XXXX
                    <span className="km-sf-foil">{t.ticketCover}</span>
                  </div>
                  <p className="km-sf-ticket-note">{t.ticketNote}</p>
                </div>
              ) : null}
            </section>

            <section id="km-sf-products" className="km-sf-shop">
              <div className="km-sf-shop-bar">
                <h2 className="km-sf-shop-title">{t.allProducts}</h2>
                {showRegions ? (
                  <div className="km-sf-filters" role="tablist" aria-label={t.allRegions}>
                    <button
                      type="button"
                      className={`km-sf-cat${regionFilter === "" ? " km-sf-cat-active" : ""}`}
                      onClick={() => chooseRegion("")}
                    >
                      {t.allRegions}
                    </button>
                    {regionOptions.map((region) => (
                      <button
                        key={region.code}
                        type="button"
                        className={`km-sf-cat${regionFilter === region.code.toLowerCase() ? " km-sf-cat-active" : ""}`}
                        onClick={() => chooseRegion(region.code.toLowerCase())}
                      >
                        <RegionBadge country={region.country} regionLabel={region.zh} compact={lang === "en"} />
                      </button>
                    ))}
                  </div>
                ) : null}
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
              </div>
              {showCategories ? (
                <div className="km-sf-filters" role="tablist" aria-label="商品分类">
                  <button
                    type="button"
                    className={`km-sf-cat${filter === "all" ? " km-sf-cat-active" : ""}`}
                    onClick={() => setFilter("all")}
                  >
                    {t.allCategory}
                  </button>
                  {categories.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`km-sf-cat${filter === item.id ? " km-sf-cat-active" : ""}`}
                      onClick={() => setFilter(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}

              {visible.length ? (
                productGroups.map((group) => (
                  <div key={group.id} className="km-sf-group">
                    {sellsCodes && sellsAccounts ? (
                      <div className="km-sf-group-head">
                        <h3>{t.groups[group.id].title}</h3>
                        <p>{t.groups[group.id].desc}</p>
                      </div>
                    ) : null}
                    <div className="km-sf-grid2">{group.items.map(renderProductCard)}</div>
                  </div>
                ))
              ) : regionFilter ? (
                <div className="km-sf-empty">
                  <p>{t.regionEmpty}</p>
                  <button type="button" className="km-btn" onClick={() => chooseRegion("")}>
                    {t.seeAllRegions}
                  </button>
                </div>
              ) : (
                <p className="km-sf-empty">{t.empty}</p>
              )}
            </section>

            <div className="km-sf-help">
              {config.queryEnabled ? <StorefrontEmailLookup slug={slug} live={live} t={t} /> : null}
              <a
                href={redeemUrl}
                className="km-sf-redeem"
                {...(isExternalRedeemUrl(redeemUrl)
                  ? { target: "_blank", rel: "noreferrer" }
                  : undefined)}
              >
                <div className="min-w-0">
                  <p className="km-sf-redeem-kicker">{t.redeemTitle}</p>
                  <p className="km-sf-redeem-sub">{t.redeemSub}</p>
                </div>
                <span className="km-sf-redeem-cta">
                  {t.redeemCta}
                  <span aria-hidden>↗</span>
                </span>
              </a>
            </div>

            <section className="km-sf-faq" aria-labelledby="km-sf-faq-title">
              <h2 id="km-sf-faq-title">{t.faqTitle}</h2>
              {[t.faq.noCode, ...(sellsCodes && sellsAccounts ? [t.faq.kinds] : []), ...(showRegions ? [t.faq.regions] : [])].map(
                (item) => (
                  <details key={item.q}>
                    <summary>{item.q}</summary>
                    <p>{item.a}</p>
                  </details>
                ),
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
                  <span className="km-sf-badge">
                    {active && !productAvailable(active)
                      ? t.detail.restocking
                      : active?.kind === "account"
                        ? t.inStockAccount
                        : t.detail.inStock}
                  </span>
                </div>

                <p className="km-sf-detail-desc">{pickText(active.desc, lang)}</p>

                <p className="km-sf-field-label km-sf-field-label-sep">{t.detail.priceLabel}</p>
                <p className="km-sf-detail-price">
                  {yuanTextFromCents(goodsCents)} <small>CNY</small>
                </p>

                {active.specs.length ? (
                  <>
                    <p className="km-sf-field-label">
                      {active.specs.every((spec) => spec.region)
                        ? t.detail.chooseRegion
                        : t.detail.chooseSpec}
                    </p>
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
                              setRegionConfirmed(false);
                            }}
                          >
                            <span className="km-sf-spec-row-main">
                              <span className="km-sf-spec-row-name">
                                {spec.region ? (
                                  <RegionBadge country={spec.region.country} regionLabel={spec.region.zh} size="md" />
                                ) : (
                                  pickText(spec.name, lang)
                                )}
                              </span>
                              <span className="km-sf-spec-row-stock">
                                {active && !productAvailable(active)
                                  ? t.detail.restocking
                                  : spec.stock === null
                                    ? active?.kind === "account"
                                      ? t.inStockAccount
                                      : t.detail.inStock
                                    : t.detail.stock(spec.stock)}
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

                {regionSwitchNote ? <p className="km-sf-modal-hint">{regionSwitchNote}</p> : null}
                {active.specs.filter((spec) => spec.region).length >= 2 && activeSpec?.region ? (
                  <p className="km-sf-modal-hint">
                    {t.detail.regionWarn(pickText({ zh: activeSpec.region.zh, en: activeSpec.region.en }, lang))}
                    {activeSpec.region.note ? ` ${activeSpec.region.note}` : ""}
                  </p>
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
                        <span className="km-sf-qty-hint">
                          {active?.kind === "account"
                            ? t.detail.qtyMaxAccount(specMaxQty)
                            : t.detail.qtyMax(specMaxQty)}
                        </span>
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
                  <p className="km-sf-modal-hint">
                    {active?.kind === "account"
                      ? t.detail.emailHintAccount
                      : t.detail.emailHint}
                  </p>

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

                  <p className="km-sf-field-label">{t.detail.coupon}</p>
                  <input
                    className="km-input"
                    value={couponCode}
                    onChange={(event) => setCouponCode(event.target.value)}
                    placeholder={t.detail.couponPh}
                    maxLength={20}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  {couponChecking ? (
                    <p className="km-sf-modal-hint">{t.detail.couponChecking}</p>
                  ) : couponError ? (
                    <p className="km-sf-error">{couponError}</p>
                  ) : couponQuote && couponQuote.discountCents > 0 ? (
                    <p className="km-sf-modal-hint">
                      {t.detail.couponWas(yuanTextFromCents(couponQuote.listGoodsCents))} ·{" "}
                      {couponKind === "referral"
                        ? t.detail.referralCouponOff(yuanTextFromCents(couponQuote.discountCents))
                        : t.detail.couponOff(yuanTextFromCents(couponQuote.discountCents))}
                    </p>
                  ) : null}
                  {referralCode && referralFromLink ? (
                    <p className="km-sf-modal-hint">{t.detail.referralBy}</p>
                  ) : referralCode ? (
                    <p className="km-sf-modal-hint">
                      {t.detail.referralBy} · {referralCode}
                    </p>
                  ) : referralOpen ? (
                    <>
                      <input
                        className="km-input"
                        value={referralInput}
                        onChange={(event) => {
                          setReferralInput(event.target.value);
                          setReferralInvalid(false);
                        }}
                        onBlur={() => void checkReferralInput()}
                        placeholder={t.detail.referralPh}
                        maxLength={16}
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      {referralInvalid ? <p className="km-sf-modal-hint">{t.detail.referralInvalid}</p> : null}
                    </>
                  ) : live ? (
                    <button type="button" className="km-sf-modal-hint" style={{ textDecoration: "underline" }} onClick={() => setReferralOpen(true)}>
                      {t.detail.referralAsk}
                    </button>
                  ) : null}

                  {(active?.specs ?? []).filter((spec) => spec.region).length >= 2 &&
                  activeSpec?.region ? (
                    <label className="km-sf-modal-hint" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={regionConfirmed}
                        onChange={(event) => setRegionConfirmed(event.target.checked)}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <b>
                          <RegionBadge country={activeSpec.region.country} regionLabel={activeSpec.region.zh} size="md" />
                        </b>{" "}
                        {t.detail.regionBanner(pickText({ zh: activeSpec.region.zh, en: activeSpec.region.en }, lang))}
                        <br />
                        {t.detail.regionConfirmLabel(pickText({ zh: activeSpec.region.zh, en: activeSpec.region.en }, lang))}
                      </span>
                    </label>
                  ) : null}

                  {buyError ? <p className="km-sf-error">{buyError}</p> : null}
                  {active && !productAvailable(active) ? (
                    <p className="km-sf-modal-hint">{t.detail.restockingHint}</p>
                  ) : null}

                  <button
                    type="button"
                    className="km-btn km-sf-detail-buy"
                    disabled={
                      buyBusy || Boolean(active && !productAvailable(active))
                    }
                    onClick={openInvoicePrompt}
                  >
                    {buyBusy
                      ? t.detail.payBusy
                      : active && !productAvailable(active)
                        ? t.restocking
                        : `${activeSpec?.region ? `${pickText({ zh: activeSpec.region.zh, en: activeSpec.region.en }, lang)} · ` : ""}${t.detail.pay} · ¥${yuanTextFromCents(goodsCents)}`}
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
              <a
                href={redeemUrl}
                className="km-sf-contact"
                {...(isExternalRedeemUrl(redeemUrl)
                  ? { target: "_blank", rel: "noreferrer" }
                  : undefined)}
              >
                {t.nav.redeem}
              </a>
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

      {invoiceOpen ? (
        <div
          className="km-modal-backdrop"
          onClick={() => {
            if (!buyBusy) setInvoiceOpen(false);
          }}
        >
          <div
            className="km-modal km-modal-ask km-sf-invoice-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="km-sf-invoice-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="km-sf-invoice-title">{t.detail.invoiceAskTitle}</h2>
            <p className="km-sf-invoice-warn">{t.detail.invoiceAskSub}</p>
            <label className={`km-sf-invoice-check-card${wantInvoice ? " is-on" : ""}`}>
              <input
                type="checkbox"
                checked={wantInvoice}
                onChange={(event) => {
                  setWantInvoice(event.target.checked);
                  setBuyError("");
                }}
              />
              <span>{t.detail.invoiceNeed}</span>
            </label>
            {wantInvoice ? (
              <div className="km-sf-invoice-form">
                <p className="km-sf-field-label">{t.detail.invoiceTitle}</p>
                <input
                  className="km-input"
                  value={invoiceTitle}
                  onChange={(event) => setInvoiceTitle(event.target.value)}
                  placeholder={t.detail.invoiceTitlePh}
                  maxLength={120}
                  required
                />
                <p className="km-sf-field-label">{t.detail.invoiceTaxNo}</p>
                <input
                  className="km-input"
                  value={invoiceTaxNo}
                  onChange={(event) => setInvoiceTaxNo(event.target.value)}
                  placeholder={t.detail.invoiceTaxNoPh}
                  maxLength={20}
                  autoCapitalize="characters"
                  required
                />
                <p className="km-sf-field-label">{t.detail.invoiceNote}</p>
                <input
                  className="km-input"
                  value={invoiceNote}
                  onChange={(event) => setInvoiceNote(event.target.value)}
                  placeholder={t.detail.invoiceNotePh}
                  maxLength={200}
                />
                <p className="km-sf-field-label">{t.detail.invoiceAmount}</p>
                <p className="km-sf-invoice-amount">¥{yuanTextFromCents(totalCents)}</p>
                <p className="km-sf-modal-hint">
                  {t.detail.invoiceAmountHint(
                    yuanTextFromCents(goodsCents),
                    yuanTextFromCents(surchargeCents),
                  )}
                  {couponQuote && couponQuote.discountCents > 0
                    ? ` · ${t.detail.couponOff(yuanTextFromCents(couponQuote.discountCents))}`
                    : ""}
                </p>
                <p className="km-sf-field-label">{t.detail.invoiceEmail}</p>
                <input
                  className="km-input"
                  type="email"
                  value={invoiceEmail}
                  onChange={(event) => {
                    setInvoiceEmailTouched(true);
                    setInvoiceEmail(event.target.value);
                  }}
                  placeholder={t.queryPlaceholder}
                  required
                />
                <p className="km-sf-modal-hint">{t.detail.invoiceEmailHint}</p>
              </div>
            ) : null}
            {buyError ? <p className="km-sf-error">{buyError}</p> : null}
            <div className="km-sf-invoice-actions">
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={buyBusy}
                onClick={() => setInvoiceOpen(false)}
              >
                {t.detail.invoiceCancel}
              </button>
              <button
                type="button"
                className="km-btn"
                disabled={buyBusy}
                onClick={() => void buy()}
              >
                {buyBusy
                  ? t.detail.payBusy
                  : `${t.detail.invoiceContinue} · ¥${yuanTextFromCents(totalCents)}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
