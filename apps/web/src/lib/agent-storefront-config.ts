import { z } from "zod";

import { isLocalAccountPlan } from "./finished-account-core";
import { normalizeCategory } from "./plan-category";

/** 代理店铺装修配置：服务端与客户端共用的类型、默认值与校验 */

export type Lang = "zh" | "en";

export type LocalText = { zh: string; en: string };

export const CONTACT_TYPES = ["telegram", "email", "wechat", "qq", "link"] as const;

export type ContactType = (typeof CONTACT_TYPES)[number];

export type ContactItem = {
  type: ContactType;
  label: LocalText;
  value: string;
};

export type StatItem = {
  value: string;
  label: LocalText;
};

export type HeroSettings = {
  enabled: boolean;
  chip: LocalText;
  title: LocalText;
  sub: LocalText;
};

/** 落库的装修字段（不含店名/主题/商品，那些来自 agents 表与套餐） */
export type StorefrontSettings = {
  slogan: LocalText;
  logoLetter: string;
  announcement: { enabled: boolean; text: LocalText };
  hero: HeroSettings;
  stats: { enabled: boolean; items: StatItem[] };
  searchEnabled: boolean;
  queryEnabled: boolean;
  contacts: ContactItem[];
  defaultLang: Lang;
  languages: Lang[];
  /** 按套餐键覆盖前台商品名；没写的键继续用平台套餐名 */
  productNames: Record<string, LocalText>;
};

export const MAX_STATS = 4;
export const MAX_CONTACTS = 5;

/** 代理留空时前台展示的平台默认文案 */
export const PLATFORM_HERO: HeroSettings = {
  enabled: true,
  chip: { zh: "自动发货 · 正品保障", en: "Auto delivery · 100% genuine" },
  title: { zh: "AI 工具 · 一站式自助发货", en: "AI tools, self-serve instant delivery" },
  sub: {
    zh: "主流 AI 会员与效率工具官方直充，付款成功后立即出卡，用下单邮箱随时查回。",
    en: "Official top-ups for mainstream AI memberships and productivity tools. Codes are issued instantly after payment and can be retrieved anytime with your order email.",
  },
};

export const DEFAULT_SETTINGS: StorefrontSettings = {
  slogan: { zh: "", en: "" },
  logoLetter: "",
  announcement: { enabled: false, text: { zh: "", en: "" } },
  hero: { enabled: true, chip: { zh: "", en: "" }, title: { zh: "", en: "" }, sub: { zh: "", en: "" } },
  stats: { enabled: false, items: [] },
  searchEnabled: true,
  queryEnabled: true,
  contacts: [],
  defaultLang: "zh",
  languages: ["zh"],
  productNames: {},
};

/* ———————————————————————————— 校验 ———————————————————————————— */

const localText = z.object({
  zh: z.string().trim().max(120).default(""),
  en: z.string().trim().max(200).default(""),
});

const langSchema = z.enum(["zh", "en"]);

/** 头尾店名，和超管建号时的显示名是同一列 */
export const shopNameSchema = z
  .string()
  .trim()
  .min(1, "请填写店名")
  .max(64, "店名最多 64 个字");

export const storefrontSettingsSchema = z
  .object({
    slogan: localText,
    logoLetter: z.string().trim().max(2).default(""),
    announcement: z.object({
      enabled: z.boolean(),
      text: localText,
    }),
    hero: z.object({
      enabled: z.boolean(),
      chip: localText,
      title: localText,
      sub: z.object({
        zh: z.string().trim().max(300).default(""),
        en: z.string().trim().max(400).default(""),
      }),
    }),
    stats: z.object({
      enabled: z.boolean(),
      items: z
        .array(
          z.object({
            value: z.string().trim().min(1, "统计数值不能为空").max(16),
            label: localText,
          }),
        )
        .max(MAX_STATS, `统计卡片最多 ${MAX_STATS} 个`),
    }),
    searchEnabled: z.boolean(),
    queryEnabled: z.boolean(),
    contacts: z
      .array(
        z.object({
          type: z.enum(CONTACT_TYPES),
          label: localText,
          value: z.string().trim().min(1, "联系方式不能为空").max(200),
        }),
      )
      .max(MAX_CONTACTS, `联系方式最多 ${MAX_CONTACTS} 条`),
    defaultLang: langSchema,
    languages: z.array(langSchema).min(1, "至少启用一种语言"),
    productNames: z
      .record(z.string().trim().max(64), localText)
      .default({})
      .transform((map) => {
        const next: Record<string, LocalText> = {};
        for (const [key, value] of Object.entries(map)) {
          if (!key || (!value.zh && !value.en)) continue;
          next[key] = value;
        }
        return next;
      }),
  })
  .superRefine((value, ctx) => {
    if (!value.languages.includes(value.defaultLang)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultLang"],
        message: "默认语言必须在已启用的语言里",
      });
    }
    value.contacts.forEach((contact, index) => {
      if (contact.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contacts", index, "value"],
          message: "请填写有效邮箱",
        });
      }
      if (contact.type === "link" && !/^https?:\/\//i.test(contact.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contacts", index, "value"],
          message: "链接需以 http:// 或 https:// 开头",
        });
      }
    });
  });

/* ———————————————————————————— 行 <-> 配置 ———————————————————————————— */

type SettingsRow = {
  sloganZh: string;
  sloganEn: string;
  logoLetter: string;
  announcementEnabled: boolean;
  announcementZh: string;
  announcementEn: string;
  heroJson: string;
  statsJson: string;
  searchEnabled: boolean;
  queryEnabled: boolean;
  contactsJson: string;
  defaultLang: string;
  languagesJson: string;
  productNamesJson?: string;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function pickLang(value: string): Lang {
  return value === "en" ? "en" : "zh";
}

/** 只收下写成 { zh, en } 的套餐名覆盖，脏数据直接丢掉 */
export function parseProductNames(raw: unknown): Record<string, LocalText> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const next: Record<string, LocalText> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const planKey = key.trim();
    if (!planKey || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const blob = value as { zh?: unknown; en?: unknown };
    const zh = String(blob.zh ?? "").trim();
    const en = String(blob.en ?? "").trim();
    if (!zh && !en) continue;
    next[planKey] = { zh, en };
  }
  return next;
}

/** 代理没写覆盖时用平台套餐名；英文留空回退中文覆盖或平台名 */
export function resolveProductName(
  planKey: string,
  platformName: string,
  names: Record<string, LocalText> = {},
): LocalText {
  const override = names[planKey];
  const zh = override?.zh.trim() || platformName;
  const en = override?.en.trim() || override?.zh.trim() || platformName;
  return { zh, en };
}

/** DB 行 → 配置；坏数据一律退回默认值，不让店铺打不开 */
export function rowToSettings(row: SettingsRow | null | undefined): StorefrontSettings {
  if (!row) return DEFAULT_SETTINGS;

  const hero = parseJson<Partial<HeroSettings>>(row.heroJson, {});
  const statsBlob = parseJson<{ enabled?: boolean; items?: unknown }>(row.statsJson, {});
  const rawStats = statsBlob.items;
  const rawContacts = parseJson<unknown>(row.contactsJson, []);
  const rawLanguages = parseJson<unknown>(row.languagesJson, ["zh"]);

  const stats: StatItem[] = (Array.isArray(rawStats) ? rawStats : [])
    .filter((item): item is StatItem => Boolean(item) && typeof (item as StatItem).value === "string")
    .slice(0, MAX_STATS)
    .map((item) => ({
      value: String(item.value),
      label: { zh: String(item.label?.zh ?? ""), en: String(item.label?.en ?? "") },
    }));

  const contacts: ContactItem[] = (Array.isArray(rawContacts) ? rawContacts : [])
    .filter(
      (item): item is ContactItem =>
        Boolean(item) &&
        CONTACT_TYPES.includes((item as ContactItem).type) &&
        typeof (item as ContactItem).value === "string",
    )
    .slice(0, MAX_CONTACTS)
    .map((item) => ({
      type: item.type,
      label: { zh: String(item.label?.zh ?? ""), en: String(item.label?.en ?? "") },
      value: String(item.value),
    }));

  const languages = (Array.isArray(rawLanguages) ? rawLanguages : [])
    .filter((item): item is Lang => item === "zh" || item === "en");
  const defaultLang = pickLang(row.defaultLang);
  const uniqueLanguages = Array.from(new Set(languages.length ? languages : [defaultLang]));

  return {
    slogan: {
      zh: row.sloganZh.replace(/\s*·\s*一卡一充/g, "").replace(/一卡一充\s*[·|]\s*/g, ""),
      en: row.sloganEn
        .replace(/\s*·\s*one code per order/gi, "")
        .replace(/one code per order\s*·\s*/gi, ""),
    },
    logoLetter: row.logoLetter,
    announcement: {
      enabled: row.announcementEnabled,
      text: { zh: row.announcementZh, en: row.announcementEn },
    },
    hero: {
      enabled: hero.enabled !== false,
      chip: { zh: hero.chip?.zh ?? "", en: hero.chip?.en ?? "" },
      title: { zh: hero.title?.zh ?? "", en: hero.title?.en ?? "" },
      sub: { zh: hero.sub?.zh ?? "", en: hero.sub?.en ?? "" },
    },
    stats: { enabled: statsBlob.enabled !== false, items: stats },
    searchEnabled: row.searchEnabled,
    queryEnabled: row.queryEnabled,
    contacts,
    defaultLang,
    languages: uniqueLanguages.includes(defaultLang)
      ? uniqueLanguages
      : [defaultLang, ...uniqueLanguages],
    productNames: parseProductNames(parseJson(row.productNamesJson || "{}", {})),
  };
}

/** 配置 → DB 列 */
export function settingsToRow(settings: StorefrontSettings) {
  return {
    sloganZh: settings.slogan.zh,
    sloganEn: settings.slogan.en,
    logoLetter: settings.logoLetter,
    announcementEnabled: settings.announcement.enabled,
    announcementZh: settings.announcement.text.zh,
    announcementEn: settings.announcement.text.en,
    heroJson: JSON.stringify(settings.hero),
    statsJson: JSON.stringify(settings.stats),
    searchEnabled: settings.searchEnabled,
    queryEnabled: settings.queryEnabled,
    contactsJson: JSON.stringify(settings.contacts),
    defaultLang: settings.defaultLang,
    languagesJson: JSON.stringify(settings.languages),
    productNamesJson: JSON.stringify(settings.productNames),
  };
}

/** 取双语文案，代理没填英文时回退中文，两边都空时用平台默认 */
export function pickText(text: LocalText, lang: Lang, fallback?: LocalText): string {
  const own = lang === "en" ? text.en || text.zh : text.zh;
  if (own) return own;
  if (!fallback) return "";
  return lang === "en" ? fallback.en || fallback.zh : fallback.zh;
}

/* ———————————————————————————— 前台商品视图模型 ———————————————————————————— */

/** 一个规格 = 平台一个套餐（planKey），下单时直接用它的 id */
export type StorefrontSpec = {
  id: string;
  name: LocalText;
  priceCents: number;
  auto: boolean;
  stock: number | null;
};

export type DetailLine = {
  label?: LocalText;
  text: LocalText;
  link?: string;
};

export type DetailSection = {
  icon: string;
  title: LocalText;
  lines: DetailLine[];
};

export type StorefrontProduct = {
  id: string;
  name: LocalText;
  subtitle: LocalText;
  desc: LocalText;
  category: string;
  categoryLabel: string;
  tags: LocalText[];
  /** null 表示不对外展示具体库存（卡台即时发货，没有本地池） */
  stock: number | null;
  /** false = 补货中，仍展示商品，但不允许下单。缺省当有货。 */
  available?: boolean;
  /** cdk = 卡密；account = 成品账号，订单页不走兑换 */
  kind?: "cdk" | "account";
  hue: number;
  /** 商品图位置显示的短标识，没有封面图时用 */
  mark: string;
  /** 商品卡 / 详情页装饰图，空串表示只用标识 */
  cover?: string;
  specs: StorefrontSpec[];
  detail: DetailSection[];
};

export type StorefrontConfig = StorefrontSettings & {
  shopName: string;
  themeId: string;
  products: StorefrontProduct[];
};

export const PLATFORM_SLOGAN: LocalText = {
  zh: "正品会员直充 · 正品保障",
  en: "Genuine membership top-ups · 100% genuine",
};

/**
 * 套餐名里第一个英文词，用于商品图标。
 * 短词整个留着（Plus / Pro），长词才截断——否则 "Plus" 会被切成 "PLU" 这种残句。
 */
function markFromName(name: string): string {
  const ascii = name.match(/[A-Za-z][A-Za-z0-9]*/g);
  if (ascii?.length) {
    const word = ascii[0];
    if (word.length <= 5) return word.charAt(0).toUpperCase() + word.slice(1);
    return word.slice(0, 3).toUpperCase();
  }
  return name.trim().slice(0, 2) || "AI";
}

const PLAN_COVERS: Record<string, string> = {
  plus: "/storefront/cover-plus.png?v=8",
  pro_5x: "/storefront/cover-pro-5x.png?v=8",
  pro_20x: "/storefront/cover-pro.png?v=8",
  credit250: "/storefront/cover-codex-250.png?v=8",
  credit500: "/storefront/cover-codex-500.png?v=8",
  credit1000: "/storefront/cover-codex-1000.png?v=8",
  finished_gpt: "/storefront/cover-plus.png?v=8",
};

/** 按套餐键匹配带标识的封面；没对上再按名字兜底 Claude / Grok。 */
export function coverFromPlan(name: string, planKey: string): string {
  const keyed = PLAN_COVERS[planKey];
  if (keyed) return keyed;
  const hay = `${name} ${planKey}`.toLowerCase();
  if (/\bgrok\b|xai/.test(hay)) return "/storefront/cover-grok.png?v=2";
  if (/\bclaude\b|anthropic/.test(hay)) return "/storefront/cover-claude.png?v=2";
  return "";
}

/** 用套餐键算一个稳定色相，同一套餐每次刷新颜色不变 */
function hueFromKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 360;
  }
  return hash;
}

export type SellablePlan = {
  planKey: string;
  name: string;
  description: string;
  retailPriceCents: number;
  /** 后台给套餐打的分类标签，空串表示未分类 */
  category?: string;
  fulfillmentKind?: string;
  available?: boolean;
};

/** 平台套餐 → 前台商品。一个套餐一个商品、一个规格，下单直接用 planKey */
export function planToProduct(
  plan: SellablePlan,
  names: Record<string, LocalText> = {},
): StorefrontProduct {
  const name = resolveProductName(plan.planKey, plan.name, names);
  // 分类标签本身就当 id 用：后台改标签等于换分类，不用再维护一张分类表。
  // "all" 是前台「全部」的保留值，未分类的套餐落到这里，只会出现在「全部」下。
  const category = normalizeCategory(plan.category);
  const account = isLocalAccountPlan(plan);
  const desc: LocalText = account
    ? {
        zh:
          plan.description ||
          "付款成功后立即发送成品账号（邮箱、密码和 Session），用下单邮箱可随时查回。无需兑换。",
        en:
          plan.description ||
          "A finished account is delivered right after payment. Retrieve it anytime with your order email. No redeem step.",
      }
    : {
        zh: plan.description || "付款成功后即时出卡，用下单时填写的邮箱可随时查回。",
        en: plan.description || "Codes are issued instantly after payment and retrievable with your order email.",
      };

  return {
    id: plan.planKey,
    name,
    subtitle: account
      ? { zh: "成品账号 · 付款后立即发送", en: "Finished account · instant delivery" }
      : { zh: "官方渠道 · 付款后立即出卡", en: "Official channel · instant delivery" },
    desc,
    category: category || "all",
    categoryLabel: category,
    tags: account
      ? [{ zh: "成品账号", en: "Account" }]
      : [{ zh: "官方直充", en: "Official" }],
    stock: null,
    available: plan.available !== false,
    kind: account ? "account" : "cdk",
    hue: hueFromKey(plan.planKey),
    mark: markFromName(plan.name),
    cover: coverFromPlan(plan.name, plan.planKey),
    specs: [
      {
        id: plan.planKey,
        name: { zh: "预设规格", en: "Standard" },
        priceCents: plan.retailPriceCents,
        auto: true,
        stock: null,
      },
    ],
    detail: [
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
            text: account
              ? {
                  zh: "支付成功后账号显示在订单页，四个字段可分别复制。这不是卡密，不要去兑换页。用下单邮箱在本页「邮箱查单」可随时找回。",
                  en: "The account appears on the order page after payment. Copy each field separately. This is not a redeem code. Find it again via “Track by email”.",
                }
              : {
                  zh: "支付成功后立即出卡，卡密直接显示在订单页；用下单时填写的邮箱在本页「邮箱查单」可随时找回。",
                  en: "The code appears on the order page right after payment, and you can always find it again via “Track by email” on this page using your order email.",
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
            text: account
              ? {
                  zh: "数字商品售出后不支持无理由退款；账号问题请联系客服。",
                  en: "Digital goods are non-refundable without cause. Contact support for account issues.",
                }
              : {
                  zh: "可自行申请退款，卡台会收取 10% 手续费。",
                  en: "You can request a refund yourself; the card platform charges a 10% fee.",
                },
          },
          {
            text: {
              zh: "如遇发货异常，请通过页面底部的联系方式联系客服处理。",
              en: "If delivery fails, contact support via the links in the page footer.",
            },
          },
        ],
      },
    ],
  };
}
