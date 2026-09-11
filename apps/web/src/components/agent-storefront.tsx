"use client";

import { useEffect, useMemo, useState } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import { readApiJson } from "@/lib/http-error";
import { invoiceSurchargeCents } from "@/lib/invoice-core";
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
import {
  DEFAULT_AGENT_REDEEM_URL,
  isExternalRedeemUrl,
} from "@/lib/agent-redeem-core";
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

const QUERY_PREVIEW = 5;
const PAID_PAY = new Set(["paid", "success"]);
const ISSUED_FULFILL = new Set(["delivered", "fulfilled", "success", "issued"]);
const BAD_PAY = new Set(["refunded", "refunding", "chargeback"]);
const BAD_FULFILL = new Set(["failed", "expired", "cancelled"]);

function isPaidOrder(order: EmailOrder) {
  return PAID_PAY.has(order.payStatus);
}

function isIssuedOrder(order: EmailOrder) {
  return ISSUED_FULFILL.has(order.fulfillStatus);
}

function orderTone(order: EmailOrder): "ok" | "wait" | "bad" {
  if (BAD_PAY.has(order.payStatus) || BAD_FULFILL.has(order.fulfillStatus)) return "bad";
  if (isPaidOrder(order) && isIssuedOrder(order)) return "ok";
  return "wait";
}

function orderRank(order: EmailOrder) {
  const tone = orderTone(order);
  if (tone === "ok") return 0;
  if (isPaidOrder(order)) return 1;
  if (tone === "bad") return 3;
  return 2;
}

function orderStatusText(order: EmailOrder) {
  const pay = publicStatusLabel(order.payStatus, "pay");
  if (!isPaidOrder(order)) return pay;
  const fulfill = publicStatusLabel(order.fulfillStatus, "fulfill");
  return fulfill && fulfill !== pay ? `${pay} · ${fulfill}` : pay;
}

const DEMO_EMAIL_ORDERS: EmailOrder[] = [
  { orderNo: "RS20260908001PLUS", productName: "Plus", amountCents: 15000, payStatus: "paid", fulfillStatus: "delivered", queryToken: "" },
  { orderNo: "RS20260908002PRO", productName: "Pro", amountCents: 115500, payStatus: "paid", fulfillStatus: "delivered", queryToken: "" },
  { orderNo: "RS20260908003C500", productName: "Codex 点数 500", amountCents: 22200, payStatus: "paid", fulfillStatus: "issuing", queryToken: "" },
  { orderNo: "RS20260908004PLUS", productName: "Plus", amountCents: 15000, payStatus: "unpaid", fulfillStatus: "pending", queryToken: "" },
  { orderNo: "RS20260908005PRO", productName: "Pro", amountCents: 115500, payStatus: "unpaid", fulfillStatus: "pending", queryToken: "" },
  { orderNo: "RS20260908006PLUS", productName: "Plus", amountCents: 13000, payStatus: "unpaid", fulfillStatus: "pending", queryToken: "" },
  { orderNo: "RS20260908007C250", productName: "Codex 点数 250", amountCents: 11100, payStatus: "unpaid", fulfillStatus: "pending", queryToken: "" },
  { orderNo: "RS20260908008PLUS", productName: "Plus", amountCents: 15000, payStatus: "refunded", fulfillStatus: "cancelled", queryToken: "" },
];

const CHANNEL_LABEL: Record<Channel, { zh: string; en: string }> = {
  alipay: { zh: "支付宝", en: "Alipay" },
  wxpay: { zh: "微信支付", en: "WeChat Pay" },
};

/* ———————————————————————————— 界面文案（平台内置，不开放代理修改） ———————————————————————————— */

const I18N = {
  zh: {
    nav: { home: "首页", products: "商品中心", query: "订单查询", contact: "联系客服", redeem: "去兑换" },
    redeemTitle: "已有卡密？",
    redeemSub: "买完后来这里校验卡密，填写 Session 就能开通。",
    redeemCta: "去兑换开通",
    searchPlaceholder: "搜索商品名称…",
    queryTitle: "邮箱查单",
    queryDesc: "输入下单时填写的邮箱，即可查询该邮箱在本店的全部订单与卡密。",
    queryPlaceholder: "you@example.com",
    queryButton: "查询订单",
    queryBusy: "正在查询…",
    queryNote: "无需注册账号，用下单时填写的邮箱就能找回订单与卡密",
    queryEmpty: "这个邮箱在本店还没有订单",
    queryScope: "只显示这个邮箱在本店的订单，和其他买家互不影响。",
    queryCount: (n: number) => `共 ${n} 单`,
    queryMore: (n: number) => `展开其余 ${n} 单`,
    queryLess: "收起订单",
    productsSub: "浏览当前可售套餐，付款后即时发卡",
    priceFrom: (n: string) => `¥${n} 起`,
    stock: (n: number) => `库存 ${n} 件`,
    inStockShort: "现货",
    inStockAccount: "有货",
    restocking: "补货中",
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
      restocking: "补货中",
      qty: "购买数量",
      qtyMax: (n: number) => `一次最多 ${n} 张`,
      qtyMaxAccount: (n: number) => `一次最多 ${n} 个`,
      stock: (n: number) => `库存 ${n} 件`,
      email: "接收邮箱",
      emailHint: "用于付款后查回订单与卡密，请填常用邮箱",
      emailHintAccount: "用于付款后查回订单与账号，请填常用邮箱",
      restockingHint: "这个套餐正在补货中，暂时无法下单。",
      emailRequired: "请先填写接收邮箱",
      channel: "支付方式",
      channelEmpty: "支付方式暂未开放",
      total: "应付金额",
      coupon: "优惠券",
      couponPh: "选填券码",
      couponChecking: "正在核对优惠券…",
      couponOff: (amount: string) => `已减 ¥${amount}`,
      couponWas: (amount: string) => `原价 ¥${amount}`,
      pay: "立即购买",
      payBusy: "正在创建订单…",
      previewNote: "预览模式不会真的下单",
      infoTitle: "详细资讯",
      back: "返回商品列表",
      secure: "自动发货 · 即买即用",
      invoiceAskTitle: "需要开具发票吗？",
      invoiceAskSub: "只开增值税普通发票。勾选后实付金额上浮 10%（开票服务费），该加价归平台、不计入代理佣金。",
      invoiceNeed: "需要开具发票",
      invoiceCancel: "返回",
      invoiceContinue: "去支付",
      invoiceWarn: "仅支持增值税普通发票。勾选后实付金额上浮 10%（开票服务费），该加价归平台、不计入代理佣金。",
      invoiceTitle: "发票抬头",
      invoiceTitlePh: "公司或个人名称",
      invoiceTitleRequired: "请填写发票抬头",
      invoiceNote: "发票备注",
      invoiceNotePh: "如：项目名称、订单用途",
      invoiceNoteRequired: "请填写发票备注",
      invoiceAmount: "开票金额",
      invoiceAmountHint: (goods: string, fee: string) => `商品 ¥${goods} + 开票服务费 10% ¥${fee}`,
      invoiceEmail: "收票邮箱",
      invoiceEmailHint: "发票发到这个邮箱，默认使用下单邮箱",
      invoiceEmailRequired: "请填写收票邮箱",
    },
    footerContact: "联系客服",
    rights: "版权所有",
    previewTip: "静态预览 · 点色板看各套主题",
    langLabel: "EN",
  },
  en: {
    nav: { home: "Home", products: "Products", query: "Track Order", contact: "Support", redeem: "Redeem" },
    redeemTitle: "Already have a code?",
    redeemSub: "Validate it here, add your Session, and the plan will be activated.",
    redeemCta: "Go redeem",
    searchPlaceholder: "Search products…",
    queryTitle: "Track by email",
    queryDesc: "Enter the email you used at checkout to look up all orders and codes in this shop.",
    queryPlaceholder: "you@example.com",
    queryButton: "Look up orders",
    queryBusy: "Looking up…",
    queryNote: "No account needed — use the email from checkout to find your orders and codes",
    queryEmpty: "No orders found for this email in this shop",
    queryScope: "Only orders placed with this email in this shop are shown.",
    queryCount: (n: number) => `${n} orders`,
    queryMore: (n: number) => `Show ${n} more`,
    queryLess: "Show less",
    productsSub: "Browse available plans, codes delivered instantly after payment",
    priceFrom: (n: string) => `From ¥${n}`,
    stock: (n: number) => `${n} in stock`,
    inStockShort: "In stock",
    inStockAccount: "In stock",
    restocking: "Restocking",
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
      restocking: "Restocking",
      qty: "Quantity",
      qtyMax: (n: number) => `Up to ${n} per order`,
      qtyMaxAccount: (n: number) => `Up to ${n} per order`,
      stock: (n: number) => `${n} in stock`,
      email: "Delivery email",
      emailHint: "Used to retrieve your order and codes after payment",
      emailHintAccount: "Used to retrieve your order and account after payment",
      restockingHint: "This plan is restocking and cannot be purchased right now.",
      emailRequired: "Please enter your email first",
      channel: "Payment method",
      channelEmpty: "No payment method available",
      total: "Total",
      coupon: "Coupon",
      couponPh: "Optional code",
      couponChecking: "Checking coupon…",
      couponOff: (amount: string) => `−¥${amount}`,
      couponWas: (amount: string) => `Was ¥${amount}`,
      pay: "Buy now",
      payBusy: "Creating order…",
      previewNote: "Preview mode does not place real orders",
      infoTitle: "Details",
      back: "Back to products",
      secure: "Auto delivery · ready to use",
      invoiceAskTitle: "Need an invoice?",
      invoiceAskSub: "VAT regular invoice only. Checking this adds 10% to the amount you pay. The surcharge goes to the platform, not the agent.",
      invoiceNeed: "I need an invoice",
      invoiceCancel: "Back",
      invoiceContinue: "Pay now",
      invoiceWarn: "VAT regular invoice only. Checking this adds 10% to the amount you pay. The surcharge goes to the platform, not the agent.",
      invoiceTitle: "Invoice title",
      invoiceTitlePh: "Company or personal name",
      invoiceTitleRequired: "Please enter the invoice title",
      invoiceNote: "Invoice note",
      invoiceNotePh: "e.g. project name or purpose",
      invoiceNoteRequired: "Please enter an invoice note",
      invoiceAmount: "Invoice amount",
      invoiceAmountHint: (goods: string, fee: string) => `Goods ¥${goods} + 10% invoice fee ¥${fee}`,
      invoiceEmail: "Invoice email",
      invoiceEmailHint: "The invoice will be sent here. Defaults to your order email.",
      invoiceEmailRequired: "Please enter an invoice email",
    },
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

/** 详情页左侧商品主图：有封面用图，没有就退回短标识 */
function ProductBanner({ product, lang }: { product: StorefrontProduct; lang: Lang }) {
  if (product.cover) {
    return (
      <div className="km-sf-banner km-sf-banner-photo">
        <img src={product.cover} alt="" />
      </div>
    );
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
  const [nav, setNav] = useState<"home" | "products" | "query" | "contact">("home");
  const [filter, setFilter] = useState("all");
  const [keyword, setKeyword] = useState("");

  const [queryEmail, setQueryEmail] = useState("");
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [myOrders, setMyOrders] = useState<EmailOrder[] | null>(null);
  const [ordersOpen, setOrdersOpen] = useState(false);

  const [active, setActive] = useState<StorefrontProduct | null>(null);
  const [specId, setSpecId] = useState("");
  const [qty, setQty] = useState(1);
  const [buyerEmail, setBuyerEmail] = useState("");
  const [channel, setChannel] = useState<Channel>(channels[0] || "alipay");
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyError, setBuyError] = useState("");
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [wantInvoice, setWantInvoice] = useState(false);
  const [invoiceTitle, setInvoiceTitle] = useState("");
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
  const listGoodsCents = activeSpec ? activeSpec.priceCents * qty : 0;
  const goodsCents =
    couponQuote && couponQuote.discountCents > 0 ? couponQuote.goodsCents : listGoodsCents;
  const surchargeCents = wantInvoice && goodsCents > 0 ? invoiceSurchargeCents(goodsCents) : 0;
  const totalCents = goodsCents + surchargeCents;
  const specMaxQty = Math.min(maxQty, activeSpec?.stock ?? maxQty);

  const rankedOrders = useMemo(() => {
    if (!myOrders?.length) return [];
    return [...myOrders].sort((a, b) => orderRank(a) - orderRank(b));
  }, [myOrders]);
  const hiddenOrderCount = Math.max(0, rankedOrders.length - QUERY_PREVIEW);
  const visibleOrders = ordersOpen ? rankedOrders : rankedOrders.slice(0, QUERY_PREVIEW);

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
              }),
            }),
          );
          setCouponQuote(data);
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
  }, [live, slug, activeSpec, couponCode, channel, qty]);

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
    setInvoiceOpen(false);
    setWantInvoice(false);
    setCouponCode("");
    setCouponQuote(null);
    setCouponError("");
    setInvoiceTitle("");
    setInvoiceNote("");
    setInvoiceEmailTouched(false);
    setInvoiceEmail(buyerEmail);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  async function lookupOrders() {
    const email = queryEmail.trim();
    if (!email) {
      setQueryError(t.queryDesc);
      return;
    }
    if (!live) {
      setMyOrders(DEMO_EMAIL_ORDERS);
      setOrdersOpen(false);
      setQueryError("");
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
      setOrdersOpen(false);
      if (!list.length) setQueryError(t.queryEmpty);
    } catch (reason) {
      setMyOrders(null);
      setQueryError(reason instanceof Error ? reason.message : "查单失败");
    } finally {
      setQueryBusy(false);
    }
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
      if (!invoiceNote.trim()) {
        setBuyError(t.detail.invoiceNoteRequired);
        return;
      }
      if (!(invoiceEmail.trim() || email)) {
        setBuyError(t.detail.invoiceEmailRequired);
        return;
      }
    }
    if (live && !channels.length) {
      setBuyError(t.detail.channelEmpty);
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
            invoiceNote: wantInvoice ? invoiceNote.trim() : undefined,
            invoiceEmail: wantInvoice ? (invoiceEmail.trim() || email) : undefined,
            couponCode: couponCode.trim() || undefined,
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

      <div id="km-sf-top" className="km-shell-wide space-y-12 py-6 md:py-8">
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
                      className="km-btn km-btn-sm km-sf-query-go"
                      disabled={queryBusy || !queryEmail.trim()}
                      onClick={() => void lookupOrders()}
                    >
                      {queryBusy ? t.queryBusy : t.queryButton}
                    </button>
                  </div>
                  <p className="km-sf-query-note">{queryError || t.queryNote}</p>
                  {myOrders?.length ? (
                    <div className="km-sf-orders">
                      <div className="km-sf-orders-head">
                        <p className="km-sf-query-note">{t.queryScope}</p>
                        <p className="km-sf-orders-count">{t.queryCount(myOrders.length)}</p>
                      </div>
                      {visibleOrders.map((order) => (
                        <a
                          key={order.orderNo}
                          className={`km-sf-order-row km-sf-order-${orderTone(order)}`}
                          href={
                            order.queryToken
                              ? `/shop/order/${encodeURIComponent(order.orderNo)}?qt=${encodeURIComponent(order.queryToken)}`
                              : `/shop/order/${encodeURIComponent(order.orderNo)}`
                          }
                        >
                          <span className="min-w-0">
                            <strong>{order.productName}</strong>
                            <span className="km-sf-order-status">
                              {orderStatusText(order)}
                              {(order.quantity || 1) > 1 ? ` · ${order.quantity} 张` : ""}
                            </span>
                          </span>
                          <span className="km-sf-order-amount">
                            ¥{yuanTextFromCents(order.amountCents)}
                          </span>
                        </a>
                      ))}
                      {hiddenOrderCount > 0 ? (
                        <button
                          type="button"
                          className="km-sf-orders-more"
                          onClick={() => {
                            setOrdersOpen((open) => {
                              if (open) {
                                requestAnimationFrame(() => {
                                  document.getElementById("km-sf-query")?.scrollIntoView({
                                    behavior: "smooth",
                                    block: "start",
                                  });
                                });
                              }
                              return !open;
                            });
                          }}
                        >
                          {ordersOpen ? t.queryLess : t.queryMore(hiddenOrderCount)}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

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

            <section id="km-sf-products" className="space-y-4">
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
                        <div
                          className="km-sf-card2-art"
                          style={
                            product.cover
                              ? undefined
                              : { background: `hsl(${product.hue} 18% 96%)` }
                          }
                        >
                          {product.cover ? (
                            <img src={product.cover} alt="" />
                          ) : (
                            <ProductIcon product={product} />
                          )}
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
                          <div className="km-sf-card2-foot">
                            <span className="km-sf-price2">
                              {product.specs.length > 1
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
                      {t.detail.couponOff(yuanTextFromCents(couponQuote.discountCents))}
                    </p>
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
                        : `${t.detail.pay} · ¥${yuanTextFromCents(goodsCents)}`}
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
