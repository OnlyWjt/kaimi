import type {
  DetailSection,
  StorefrontConfig,
  StorefrontProduct,
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

const DEMO_PRODUCTS: StorefrontProduct[] = [
  {
    id: "chatgpt-plus",
    name: { zh: "ChatGPT Plus 会员", en: "ChatGPT Plus" },
    subtitle: { zh: "最新 GPT 模型 · 联网与数据分析", en: "Latest GPT models · browsing & analysis" },
    desc: {
      zh: "官方渠道直充 ChatGPT Plus，支持 GPT 最新模型、联网与数据分析，付款后立即发码。",
      en: "Official ChatGPT Plus top-up with the latest GPT models, browsing and data analysis. Codes are delivered instantly.",
    },
    category: "ai",
    categoryLabel: "AI 助手",
    tags: [
      { zh: "官方直充", en: "Official" },
      { zh: "自动发货", en: "Auto delivery" },
    ],
    stock: 128,
    hue: 168,
    mark: "GPT",
    cover: "/storefront/cover-gpt.png?v=2",
    specs: [
      {
        id: "chatgpt-plus-1m",
        name: { zh: "1 个月", en: "1 month" },
        priceCents: 15800,
        auto: true,
        stock: 128,
      },
      {
        id: "chatgpt-plus-3m",
        name: { zh: "3 个月", en: "3 months" },
        priceCents: 45800,
        auto: true,
        stock: 46,
      },
    ],
    detail: buildDetail({
      zh: "官方渠道直充 ChatGPT Plus，支持 GPT 最新模型、联网与数据分析。",
      en: "Official ChatGPT Plus top-up with the latest GPT models.",
    }),
  },
  {
    id: "claude-pro",
    name: { zh: "Claude Pro 会员", en: "Claude Pro" },
    subtitle: { zh: "长文本处理利器", en: "Built for long documents" },
    desc: {
      zh: "Claude Pro 支持超长上下文与文件分析，适合写作、代码审查与资料整理。",
      en: "Claude Pro handles very long context and file analysis — great for writing, code review and research.",
    },
    category: "ai",
    categoryLabel: "AI 助手",
    tags: [
      { zh: "长上下文", en: "Long context" },
      { zh: "自动发货", en: "Auto delivery" },
    ],
    stock: 64,
    hue: 28,
    mark: "CL",
    cover: "/storefront/cover-claude.png?v=2",
    specs: [
      {
        id: "claude-pro-1m",
        name: { zh: "预设规格", en: "Standard" },
        priceCents: 14800,
        auto: true,
        stock: 64,
      },
    ],
    detail: buildDetail({
      zh: "Claude Pro 支持超长上下文与文件分析，适合写作与代码审查。",
      en: "Claude Pro handles very long context and file analysis.",
    }),
  },
  {
    id: "grok",
    name: { zh: "Grok 会员", en: "Grok" },
    subtitle: { zh: "实时信息 · 更敢说", en: "Realtime · a bit more blunt" },
    desc: {
      zh: "Grok 会员，适合要看实时信息和少绕弯的回答。付款后立即出卡。",
      en: "Grok membership for realtime context and more direct answers.",
    },
    category: "ai",
    categoryLabel: "AI 助手",
    tags: [{ zh: "官方直充", en: "Official" }],
    stock: 40,
    hue: 250,
    mark: "Grok",
    cover: "/storefront/cover-grok.png?v=2",
    specs: [
      {
        id: "grok-1m",
        name: { zh: "1 个月", en: "1 month" },
        priceCents: 16800,
        auto: true,
        stock: 40,
      },
    ],
    detail: buildDetail({
      zh: "Grok 会员，适合要看实时信息和少绕弯的回答。",
      en: "Grok membership for realtime context and more direct answers.",
    }),
  },
  {
    id: "midjourney",
    name: { zh: "Midjourney 绘画会员", en: "Midjourney" },
    subtitle: { zh: "AI 出图 · 商用授权", en: "AI images · commercial use" },
    desc: {
      zh: "Midjourney 标准会员，含快速出图额度与商用授权，适合设计与电商素材。",
      en: "Midjourney standard plan with fast-hours quota and commercial licence.",
    },
    category: "design",
    categoryLabel: "设计创作",
    tags: [
      { zh: "商用授权", en: "Commercial" },
      { zh: "自动发货", en: "Auto delivery" },
    ],
    stock: 32,
    hue: 268,
    mark: "MJ",
    specs: [
      {
        id: "midjourney-basic",
        name: { zh: "基础版", en: "Basic" },
        priceCents: 8800,
        auto: true,
        stock: 32,
      },
      {
        id: "midjourney-standard",
        name: { zh: "标准版", en: "Standard" },
        priceCents: 21800,
        auto: true,
        stock: 12,
      },
    ],
    detail: buildDetail({
      zh: "Midjourney 标准会员，含快速出图额度与商用授权。",
      en: "Midjourney standard plan with fast-hours quota and commercial licence.",
    }),
  },
  {
    id: "notion-ai",
    name: { zh: "Notion AI 效率套件", en: "Notion AI" },
    subtitle: { zh: "笔记 · 协作 · AI 写作", en: "Notes · docs · AI writing" },
    desc: {
      zh: "Notion AI 可在文档内直接续写、总结与翻译，团队协作与知识库整理都合适。",
      en: "Notion AI writes, summarises and translates right inside your docs.",
    },
    category: "office",
    categoryLabel: "办公效率",
    tags: [
      { zh: "团队可用", en: "Team ready" },
      { zh: "自动发货", en: "Auto delivery" },
    ],
    stock: 88,
    hue: 208,
    mark: "NA",
    specs: [
      {
        id: "notion-ai-1m",
        name: { zh: "预设规格", en: "Standard" },
        priceCents: 6800,
        auto: true,
        stock: 88,
      },
    ],
    detail: buildDetail({
      zh: "Notion AI 可在文档内直接续写、总结与翻译。",
      en: "Notion AI writes, summarises and translates inside your docs.",
    }),
  },
];

export const DEMO_STOREFRONT_CONFIG: StorefrontConfig = {
  shopName: "Kaimi 小店",
  themeId: "snow",
  slogan: {
    zh: "正品会员直充 · 一卡一充 | 正品保障",
    en: "Genuine membership top-ups · one code per order",
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
  stats: {
    enabled: true,
    items: [
      { value: "4.9", label: { zh: "买家评分", en: "Buyer rating" } },
      { value: "12k+", label: { zh: "累计成交", en: "Orders delivered" } },
    ],
  },
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
  products: DEMO_PRODUCTS,
};
