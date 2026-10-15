"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import { readApiJson } from "@/lib/http-error";
import { contactHref } from "@/lib/agent-contact-core";
import { RegionBadge } from "@/components/region-badge";
import { regionDisplay } from "@/lib/cardplatform/regions";
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
  /** 打码的订单号。完整订单号是取卡凭证，只凭邮箱拿不到。 */
  orderRef: string;
  productName: string;
  quantity?: number;
  amountCents: number;
  payStatus: string;
  fulfillStatus: string;
  paymentCountry?: string | null;
  regionLabel?: string | null;
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
const BAD_PAY = new Set(["refunded", "refunding", "chargeback", "closed"]);
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
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 15000, payStatus: "paid", fulfillStatus: "delivered" },
  { orderRef: "RS2026…2PRO", productName: "Pro", amountCents: 115500, payStatus: "paid", fulfillStatus: "delivered" },
  { orderRef: "RS2026…C500", productName: "Codex 点数 500", amountCents: 22200, payStatus: "paid", fulfillStatus: "issuing" },
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 15000, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…5PRO", productName: "Pro", amountCents: 115500, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 13000, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…C250", productName: "Codex 点数 250", amountCents: 11100, payStatus: "unpaid", fulfillStatus: "pending" },
  { orderRef: "RS2026…PLUS", productName: "Plus", amountCents: 15000, payStatus: "refunded", fulfillStatus: "cancelled" },
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
    queryDesc: "输入下单时填写的邮箱，查看该邮箱在本店的订单和发货状态。",
    queryPlaceholder: "you@example.com",
    queryButton: "查询订单",
    queryBusy: "正在查询…",
    queryNote: "无需注册账号。看卡密需要完整订单号，在付款记录（商户单号）或发货邮件里",
    verifyTitle: "查看卡密",
    verifyDesc: "输入完整订单号，在支付宝/微信付款记录的「商户单号」或发货邮件里。",
    verifyPlaceholder: "完整订单号，例如 KS2026…",
    verifyButton: "查看",
    verifyBusy: "正在核对…",
    mailLinks: "把查单链接发到这个邮箱",
    mailLinksBusy: "正在发送…",
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
    allRegions: "全部地区",
    regionEmpty: "这个地区暂时没有在售商品",
    seeAllRegions: "看全部地区",
    allProducts: "全部商品",
    stepsLabel: "购买流程",
    steps: [
      { title: "选商品付款", desc: "支付宝或微信" },
      { title: "立刻拿到卡密", desc: "页面直接显示，也发到邮箱" },
      { title: "去兑换开通", desc: "校验卡密，填 Session 就开" },
    ],
    stepsAccount: [
      { title: "选商品付款", desc: "支付宝或微信" },
      { title: "立刻拿到账号", desc: "页面直接显示，也发到邮箱" },
      { title: "直接登录使用", desc: "不用兑换" },
    ],
    ticketLabel: "示意：付款后卡密显示的样子",
    ticketBadge: "示例",
    ticketCover: "付款后显示",
    ticketNote: "付款后卡密直接出现在页面上，同时发到你的下单邮箱。",
    groups: {
      cdk: { title: "会员卡密", desc: "付款后出卡密，再去兑换页开通到你的账号" },
      account: { title: "成品账号", desc: "付款后直接发能登录的账号，不用兑换" },
    },
    faqTitle: "买之前常问",
    faq: {
      noCode: {
        q: "付完款没看到卡密怎么办？",
        a: "先别重复付款。页面写着还在生成就等一下，买多张时会先出一部分。几分钟后还没有，用「邮箱查单」看状态，或把订单号发给店主。",
      },
      kinds: {
        q: "会员卡密和成品账号有什么区别？",
        a: "卡密要拿去兑换页，开通到你自己的账号上；成品账号是付款后直接给你一个能登录的账号，不用兑换。",
      },
      regions: {
        q: "不同地区怎么选？",
        a: "地区是开通时使用的付款地区，价格不同。不确定选哪个，先问店主再下单。",
      },
    },
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
      referralBy: "由好友邀请",
      referralAsk: "有好友邀请码？",
      referralPh: "好友给你的邀请码",
      referralInvalid: "邀请码不对，可以不填",
      referralCouponOff: (amount: string) => `邀请券 立减 ¥${amount}`,
      pay: "立即购买",
      chooseRegion: "选择付款地区",
      regionWarn: (region: string) =>
        `你选的是【${region}】卡密。付款地区在出卡时写进卡密，兑换时按该地区结账，买错不能换区。不确定选哪个，先问店主。`,
      regionConfirmLabel: (region: string) =>
        `我已确认购买的是【${region}】卡密，买错不能换区`,
      regionConfirmRequired: "请先确认付款地区",
      regionBanner: (region: string) => `兑换时按${region}结账，付款后不能换区、不能退换`,
      regionSwitched: (from: string, to: string) => `${from}暂停销售，已为你切到${to}`,
      payBusy: "正在创建订单…",
      previewNote: "预览模式不会真的下单",
      infoTitle: "详细资讯",
      back: "返回商品列表",
      secure: "自动发货 · 即买即用",
      invoiceAskTitle: "需要开具发票吗？",
      invoiceAskSub: "只开增值税普通发票。勾选后实付金额上浮 10%（开票服务费）。",
      invoiceNeed: "需要开具发票",
      invoiceCancel: "返回",
      invoiceContinue: "去支付",
      invoiceWarn: "仅支持增值税普通发票。勾选后实付金额上浮 10%（开票服务费）。",
      invoiceTitle: "发票抬头（必填）",
      invoiceTitlePh: "公司或个人名称",
      invoiceTitleRequired: "请填写发票抬头",
      invoiceTaxNo: "纳税人识别号（必填）",
      invoiceTaxNoPh: "15–20 位字母或数字",
      invoiceTaxNoRequired: "请填写纳税人识别号",
      invoiceTaxNoInvalid: "纳税人识别号须为 15–20 位字母或数字",
      invoiceNote: "发票备注",
      invoiceNotePh: "如：项目名称、订单用途",
      invoiceNoteRequired: "请填写发票备注",
      invoiceAmount: "开票金额",
      invoiceAmountHint: (goods: string, fee: string) => `商品 ¥${goods} + 开票服务费 10% ¥${fee}`,
      invoiceEmail: "收票邮箱（必填）",
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
    queryDesc: "Enter the email you used at checkout to see your orders and delivery status in this shop.",
    queryPlaceholder: "you@example.com",
    queryButton: "Look up orders",
    queryBusy: "Looking up…",
    queryNote: "No account needed. To see codes, enter the full order number from your payment record or delivery email",
    verifyTitle: "View codes",
    verifyDesc: "Enter the full order number. It is the merchant order number in your payment record, or in the delivery email.",
    verifyPlaceholder: "Full order number, e.g. KS2026…",
    verifyButton: "View",
    verifyBusy: "Checking…",
    mailLinks: "Email me the order links",
    mailLinksBusy: "Sending…",
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
    allRegions: "All regions",
    regionEmpty: "Nothing on sale in this region right now",
    seeAllRegions: "See all regions",
    allProducts: "All products",
    stepsLabel: "How buying works",
    steps: [
      { title: "Pick and pay", desc: "Alipay or WeChat Pay" },
      { title: "Get your code", desc: "Shown on the page and emailed to you" },
      { title: "Redeem it", desc: "Validate the code and add your Session" },
    ],
    stepsAccount: [
      { title: "Pick and pay", desc: "Alipay or WeChat Pay" },
      { title: "Get your account", desc: "Shown on the page and emailed to you" },
      { title: "Sign in", desc: "No redeem step" },
    ],
    ticketLabel: "Example: where your code appears after payment",
    ticketBadge: "Example",
    ticketCover: "Revealed after payment",
    ticketNote: "Your code shows up right on the page after payment, and is emailed to your order address.",
    groups: {
      cdk: { title: "Membership codes", desc: "Get a code after payment, then redeem it onto your account" },
      account: { title: "Ready-made accounts", desc: "Get a working account after payment. No redeem step" },
    },
    faqTitle: "Before you buy",
    faq: {
      noCode: {
        q: "I paid but don't see a code",
        a: "Don't pay again. If the page says it is still issuing, wait a moment; multi-code orders may arrive in parts. If nothing shows after a few minutes, check “Track by email” or send your order number to the shop owner.",
      },
      kinds: {
        q: "Codes vs. ready-made accounts?",
        a: "A code is redeemed onto your own account on the redeem page. A ready-made account is a working login delivered after payment, with no redeem step.",
      },
      regions: {
        q: "Which region should I pick?",
        a: "The region is the billing region used to activate the plan, and prices differ by region. If you're not sure, ask the shop owner before ordering.",
      },
    },
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
      referralBy: "Invited by a friend",
      referralAsk: "Have an invite code?",
      referralPh: "Invite code from your friend",
      referralInvalid: "Invite code not found. You can leave it empty",
      referralCouponOff: (amount: string) => `Invite coupon −¥${amount}`,
      pay: "Buy now",
      chooseRegion: "Choose payment region",
      regionWarn: (region: string) =>
        `This is a ${region} code. The payment region is fixed when the code is issued and used at redemption. It can't be changed after purchase.`,
      regionConfirmLabel: (region: string) =>
        `I confirm this is a ${region} code and the region can't be changed`,
      regionConfirmRequired: "Please confirm the payment region first",
      regionBanner: (region: string) =>
        `Redeemed as ${region}. Region can't be changed or refunded after payment.`,
      regionSwitched: (from: string, to: string) => `${from} is paused. Switched to ${to}.`,
      payBusy: "Creating order…",
      previewNote: "Preview mode does not place real orders",
      infoTitle: "Details",
      back: "Back to products",
      secure: "Auto delivery · ready to use",
      invoiceAskTitle: "Need an invoice?",
      invoiceAskSub: "VAT regular invoice only. Checking this adds 10% to the amount you pay (invoice service fee).",
      invoiceNeed: "I need an invoice",
      invoiceCancel: "Back",
      invoiceContinue: "Pay now",
      invoiceWarn: "VAT regular invoice only. Checking this adds 10% to the amount you pay (invoice service fee).",
      invoiceTitle: "Invoice title (required)",
      invoiceTitlePh: "Company or personal name",
      invoiceTitleRequired: "Please enter the invoice title",
      invoiceTaxNo: "Taxpayer ID (required)",
      invoiceTaxNoPh: "15–20 letters or digits",
      invoiceTaxNoRequired: "Please enter the taxpayer ID",
      invoiceTaxNoInvalid: "Taxpayer ID must be 15–20 letters or digits",
      invoiceNote: "Invoice note",
      invoiceNotePh: "e.g. project name or purpose",
      invoiceNoteRequired: "Please enter an invoice note",
      invoiceAmount: "Invoice amount",
      invoiceAmountHint: (goods: string, fee: string) => `Goods ¥${goods} + 10% invoice fee ¥${fee}`,
      invoiceEmail: "Invoice email (required)",
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

function CoverPhoto({
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
function ProductBanner({ product, lang }: { product: StorefrontProduct; lang: Lang }) {
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

  const [queryEmail, setQueryEmail] = useState("");
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [myOrders, setMyOrders] = useState<EmailOrder[] | null>(null);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [canMailLinks, setCanMailLinks] = useState(false);
  const [verifyOrderNo, setVerifyOrderNo] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState("");

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
      const data = await readApiJson<{ list?: EmailOrder[]; canMailLinks?: boolean }>(
        await fetch(
          `/api/public/store-orders?slug=${encodeURIComponent(slug)}&email=${encodeURIComponent(email)}`,
          { cache: "no-store" },
        ),
      );
      const list = data.list || [];
      setMyOrders(list);
      setCanMailLinks(Boolean(data.canMailLinks));
      setVerifyMessage("");
      setOrdersOpen(false);
      if (!list.length) setQueryError(t.queryEmpty);
    } catch (reason) {
      setMyOrders(null);
      setQueryError(reason instanceof Error ? reason.message : "查单失败");
    } finally {
      setQueryBusy(false);
    }
  }

  async function openVerifiedOrder() {
    const orderNo = verifyOrderNo.trim().toUpperCase();
    if (!orderNo || !live) return;
    setVerifyBusy(true);
    setVerifyMessage("");
    try {
      const data = await readApiJson<{ orderNo: string; queryToken: string }>(
        await fetch("/api/public/store-orders/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, email: queryEmail.trim(), orderNo }),
        }),
      );
      window.sessionStorage.setItem(`kaimi-order-token:${data.orderNo}`, data.queryToken);
      window.location.href = `/shop/order/${encodeURIComponent(data.orderNo)}?qt=${encodeURIComponent(data.queryToken)}`;
    } catch (reason) {
      setVerifyMessage(reason instanceof Error ? reason.message : "核对失败");
    } finally {
      setVerifyBusy(false);
    }
  }

  async function mailOrderLinks() {
    if (!live) return;
    setMailBusy(true);
    setVerifyMessage("");
    try {
      const data = await readApiJson<{ message?: string }>(
        await fetch("/api/public/store-orders/send-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, email: queryEmail.trim() }),
        }),
      );
      setVerifyMessage(data.message || "");
    } catch (reason) {
      setVerifyMessage(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      setMailBusy(false);
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
                        {visibleOrders.map((order, index) => (
                          <div
                            key={`${order.orderRef}-${index}`}
                            className={`km-sf-order-row km-sf-order-${orderTone(order)}`}
                          >
                            <span className="min-w-0">
                              <strong>{order.productName}</strong>
                              <span className="km-sf-order-status font-mono">{order.orderRef}</span>
                              {order.paymentCountry !== null && order.paymentCountry !== undefined ? (
                                <RegionBadge
                                  country={order.paymentCountry}
                                  regionLabel={order.regionLabel || ""}
                                />
                              ) : null}
                              <span className="km-sf-order-status">
                                {orderStatusText(order)}
                                {(order.quantity || 1) > 1 ? ` · ${order.quantity} 张` : ""}
                              </span>
                            </span>
                            <span className="km-sf-order-amount">
                              ¥{yuanTextFromCents(order.amountCents)}
                            </span>
                          </div>
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
                        <div className="space-y-1 pt-2">
                          <p className="km-sf-query-title text-sm">{t.verifyTitle}</p>
                          <p className="km-sf-query-note">{t.verifyDesc}</p>
                          <div className="km-sf-query-row">
                            <input
                              className="km-input font-mono"
                              value={verifyOrderNo}
                              onChange={(event) => setVerifyOrderNo(event.target.value)}
                              placeholder={t.verifyPlaceholder}
                              aria-label={t.verifyTitle}
                            />
                            <button
                              type="button"
                              className="km-btn km-btn-sm km-sf-query-go"
                              disabled={verifyBusy || !verifyOrderNo.trim()}
                              onClick={() => void openVerifiedOrder()}
                            >
                              {verifyBusy ? t.verifyBusy : t.verifyButton}
                            </button>
                          </div>
                          {canMailLinks ? (
                            <button
                              type="button"
                              className="km-sf-orders-more"
                              disabled={mailBusy}
                              onClick={() => void mailOrderLinks()}
                            >
                              {mailBusy ? t.mailLinksBusy : t.mailLinks}
                            </button>
                          ) : null}
                          {verifyMessage ? <p className="km-sf-query-note">{verifyMessage}</p> : null}
                        </div>
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
