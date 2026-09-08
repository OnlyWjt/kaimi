import { z } from "zod";

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
};

export const MAX_STATS = 4;
export const MAX_CONTACTS = 5;

/** 代理留空时前台展示的平台默认文案 */
export const PLATFORM_HERO: HeroSettings = {
  enabled: true,
  chip: { zh: "自动发货 · 正品保障", en: "Auto delivery · 100% genuine" },
  title: { zh: "AI 工具 · 一站式自助发货", en: "AI tools, self-serve instant delivery" },
  sub: {
    zh: "主流 AI 会员与效率工具官方直充，付款后卡密秒发到邮箱，无需等待。",
    en: "Official top-ups for mainstream AI memberships and productivity tools. Codes are sent to your email right after payment.",
  },
};

export const DEFAULT_SETTINGS: StorefrontSettings = {
  slogan: { zh: "", en: "" },
  logoLetter: "",
  announcement: { enabled: false, text: { zh: "", en: "" } },
  hero: { enabled: true, chip: { zh: "", en: "" }, title: { zh: "", en: "" }, sub: { zh: "", en: "" } },
  stats: { enabled: true, items: [] },
  searchEnabled: true,
  queryEnabled: true,
  contacts: [],
  defaultLang: "zh",
  languages: ["zh"],
};

/* ———————————————————————————— 校验 ———————————————————————————— */

const localText = z.object({
  zh: z.string().trim().max(120).default(""),
  en: z.string().trim().max(200).default(""),
});

const langSchema = z.enum(["zh", "en"]);

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
    slogan: { zh: row.sloganZh, en: row.sloganEn },
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
  hue: number;
  mark: string;
  banner: { line1: LocalText; line2: LocalText; line3: string };
  specs: StorefrontSpec[];
  detail: DetailSection[];
};

export type StorefrontConfig = StorefrontSettings & {
  shopName: string;
  themeId: string;
  products: StorefrontProduct[];
};

export const PLATFORM_SLOGAN: LocalText = {
  zh: "正品会员直充 · 一卡一充 | 正品保障",
  en: "Genuine membership top-ups · one code per order",
};

/** 套餐名首字母/首词，用于商品图标 */
function markFromName(name: string): string {
  const ascii = name.match(/[A-Za-z]+/g);
  if (ascii?.length) return ascii[0].slice(0, 3).toUpperCase();
  return name.trim().slice(0, 2) || "AI";
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
};

/** 平台套餐 → 前台商品。一个套餐一个商品、一个规格，下单直接用 planKey */
export function planToProduct(plan: SellablePlan): StorefrontProduct {
  const name: LocalText = { zh: plan.name, en: plan.name };
  const desc: LocalText = {
    zh: plan.description || "付款成功后即时发卡，卡密发送到你填写的邮箱。",
    en: plan.description || "Codes are delivered to your email right after payment.",
  };

  return {
    id: plan.planKey,
    name,
    subtitle: { zh: "官方直充 · 自动发货", en: "Official top-up · auto delivery" },
    desc,
    category: "all",
    categoryLabel: markFromName(plan.name),
    tags: [
      { zh: "官方直充", en: "Official" },
      { zh: "自动发货", en: "Auto delivery" },
    ],
    stock: null,
    hue: hueFromKey(plan.planKey),
    mark: markFromName(plan.name),
    banner: {
      line1: name,
      line2: { zh: "现货自动发货", en: "In stock · auto delivery" },
      line3: markFromName(plan.name),
    },
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
            text: {
              zh: "下单并支付成功后，卡密会自动发送到你填写的邮箱，同时可在本页「邮箱查单」随时找回。",
              en: "After payment the code is emailed to you automatically, and you can always find it again via “Track by email” on this page.",
            },
          },
        ],
      },
      {
        icon: "⚠️",
        title: { zh: "质保说明", en: "Warranty" },
        lines: [
          {
            label: { zh: "购买即认可", en: "By purchasing" },
            text: {
              zh: "虚拟商品一经发货不支持退款，下单前请确认所选套餐无误。",
              en: "Virtual goods are non-refundable once delivered. Please confirm your plan before ordering.",
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
