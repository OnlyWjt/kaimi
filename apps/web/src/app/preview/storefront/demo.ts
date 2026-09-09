import {
  planToProduct,
  type DetailSection,
  type StorefrontConfig,
  type StorefrontProduct,
} from "@/lib/agent-storefront-config";

/** 静态预览用的假数据，只服务 /preview/storefront，不参与线上店铺 */

function buildDetail(desc: { zh: string; en: string }): DetailSection[] {
  return [
    {
      icon: "🎁",
      title: { zh: "商品说明", en: "About this item" },
      lines: [{ text: desc }],
    },
    {
      icon: "📌",
      title: { zh: "使用说明", en: "How to use" },
      lines: [
        {
          text: {
            zh: "支付成功后立即出卡，卡密直接显示在订单页；用下单邮箱在本页「邮箱查单」可随时找回。",
            en: "The code appears on the order page right after payment, and you can find it again via “Track by email”.",
          },
        },
      ],
    },
    {
      icon: "⚠️",
      title: { zh: "质保说明", en: "Warranty" },
      lines: [
        {
          label: { zh: "质保范围", en: "Covered" },
          text: {
            zh: "只质保订阅本身，账号封禁不在质保范围内。",
            en: "Only the subscription itself is covered. Account bans are not covered.",
          },
        },
        {
          label: { zh: "退款", en: "Refunds" },
          text: {
            zh: "可自行申请退款，卡台会收取 10% 手续费。",
            en: "You can request a refund yourself; the card platform charges a 10% fee.",
          },
        },
      ],
    },
  ];
}

function demoProduct(input: {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  cover: string;
  priceCents: number;
  hue: number;
  mark: string;
  subtitle: string;
}): StorefrontProduct {
  const name = { zh: input.name, en: input.name };
  const desc = {
    zh: "官方渠道直充，付款成功后立即出卡，用下单邮箱随时查回。",
    en: "Official channel. Codes are issued instantly after payment.",
  };
  return {
    id: input.id,
    name,
    subtitle: { zh: input.subtitle, en: input.subtitle },
    desc,
    category: input.category,
    categoryLabel: input.categoryLabel,
    tags: [{ zh: "官方直充", en: "Official" }],
    stock: null,
    hue: input.hue,
    mark: input.mark,
    cover: input.cover,
    specs: [
      {
        id: input.id,
        name: { zh: "预设规格", en: "Standard" },
        priceCents: input.priceCents,
        auto: true,
        stock: null,
      },
    ],
    detail: buildDetail(desc),
  };
}

/** 预览按生产环境六个套餐排，方便对封面 */
const DEMO_PRODUCTS: StorefrontProduct[] = [
  demoProduct({
    id: "plus",
    name: "Plus",
    category: "会员",
    categoryLabel: "会员",
    cover: "/storefront/cover-plus.png?v=8",
    priceCents: 15000,
    hue: 168,
    mark: "Plus",
    subtitle: "官方渠道 · 付款后立即出卡",
  }),
  demoProduct({
    id: "pro_5x",
    name: "Pro 5x",
    category: "会员",
    categoryLabel: "会员",
    cover: "/storefront/cover-pro-5x.png?v=8",
    priceCents: 85000,
    hue: 170,
    mark: "Pro",
    subtitle: "官方渠道 · 付款后立即出卡",
  }),
  demoProduct({
    id: "pro_20x",
    name: "Pro",
    category: "会员",
    categoryLabel: "会员",
    cover: "/storefront/cover-pro.png?v=8",
    priceCents: 115500,
    hue: 172,
    mark: "Pro",
    subtitle: "官方渠道 · 付款后立即出卡",
  }),
  demoProduct({
    id: "credit250",
    name: "Codex 点数 250",
    category: "gpt点数",
    categoryLabel: "gpt点数",
    cover: "/storefront/cover-codex-250.png?v=8",
    priceCents: 11100,
    hue: 175,
    mark: "250",
    subtitle: "官方渠道 · 付款后立即出卡",
  }),
  demoProduct({
    id: "credit500",
    name: "Codex 点数 500",
    category: "gpt点数",
    categoryLabel: "gpt点数",
    cover: "/storefront/cover-codex-500.png?v=8",
    priceCents: 22200,
    hue: 178,
    mark: "500",
    subtitle: "官方渠道 · 付款后立即出卡",
  }),
  demoProduct({
    id: "credit1000",
    name: "Codex 点数 1000",
    category: "gpt点数",
    categoryLabel: "gpt点数",
    cover: "/storefront/cover-codex-1000.png?v=8",
    priceCents: 33300,
    hue: 180,
    mark: "1000",
    subtitle: "官方渠道 · 付款后立即出卡",
  }),
  planToProduct({
    planKey: "finished_gpt",
    name: "GPT 成品号",
    description: "",
    retailPriceCents: 990,
    category: "会员",
    fulfillmentKind: "local_account",
    available: false,
  }),
];

export const DEMO_STOREFRONT_CONFIG: StorefrontConfig = {
  shopName: "Kaimi 小店",
  themeId: "snow",
  slogan: {
    zh: "正品会员直充 · 正品保障",
    en: "Genuine membership top-ups · 100% genuine",
  },
  logoLetter: "K",
  announcement: { enabled: false, text: { zh: "", en: "" } },
  hero: {
    enabled: true,
    chip: { zh: "自动发货 · 正品保障", en: "Auto delivery · 100% genuine" },
    title: {
      zh: "AI 工具 · 一站式自助发货",
      en: "AI tools, self-serve instant delivery",
    },
    sub: {
      zh: "主流 AI 会员与效率工具官方直充，付款成功后立即出卡，用下单邮箱随时查回。",
      en: "Official top-ups for mainstream AI tools. Codes are issued instantly after payment.",
    },
  },
  stats: { enabled: false, items: [] },
  searchEnabled: true,
  queryEnabled: true,
  contacts: [
    {
      type: "telegram",
      label: { zh: "Telegram", en: "Telegram" },
      value: "@kaimi_support",
    },
    {
      type: "email",
      label: { zh: "售后邮箱", en: "Support email" },
      value: "help@kaimi.shop",
    },
  ],
  defaultLang: "zh",
  languages: ["zh", "en"],
  productNames: {},
  products: DEMO_PRODUCTS,
};
