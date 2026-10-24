/**
 * 卡台产品线：ChatGPT / X 订阅码 / Grok。
 * 纯函数，前后台共用，不能 import 数据库。
 *
 * 卡台目录 GET /gpt-direct/plans 不带 product 时只回 GPT；X / Grok 要带 ?product=x|grok。
 * 那两条线的定价表键带前缀（x_premium_monthly / grok_premium_monthly），注册表是裸键，
 * 而裸 premium_* 在 X 和 Grok 里同名——所以本站 plan_key 一律带产品前缀，靠前缀分线。
 *
 * 新产品线要等卡台出「产品列表」接口再接，这里不做探测。
 */

export type CardProduct = "gpt" | "x" | "grok";

export type CardProductSpec = {
  key: CardProduct;
  /** 后台和兑换页上的名字 */
  label: string;
  /** 套餐名前缀：卡台注册表里 Grok 的文案是「Premium 月付」这种不带产品名的，要补上。 */
  brand: string;
  /** 新同步进来的套餐默认放进的店铺分类。GPT 不填，保持现状。 */
  defaultCategory: string;
  /** 本站 plan_key 的前缀 */
  localPrefix: string;
  /** 固定付款地区。Grok 卡台一律按 US 收单。 */
  fixedCountry: string;
  /** 卡台没说时的默认付款地区。空串 = 菲区（GPT 老规矩，发码时不传）。 */
  defaultCountry: string;
  /** 卡台允许的付款地区。空数组 = 不限，以卡台下发为准。 */
  allowedCountries: string[];
  /** 预检会不会回 preflight_token。Grok 只查账号，兑换时直接带登录态。 */
  preflightToken: boolean;
};

export const CARD_PRODUCTS: Record<CardProduct, CardProductSpec> = {
  gpt: {
    key: "gpt",
    label: "ChatGPT",
    brand: "",
    defaultCategory: "",
    localPrefix: "",
    fixedCountry: "",
    defaultCountry: "",
    allowedCountries: [],
    preflightToken: true,
  },
  x: {
    key: "x",
    label: "X 订阅码",
    brand: "X",
    defaultCategory: "X 订阅码",
    localPrefix: "x_",
    fixedCountry: "",
    defaultCountry: "JP",
    allowedCountries: ["US", "JP", "PH", "NG", "TR", "EG"],
    preflightToken: true,
  },
  grok: {
    key: "grok",
    label: "Grok",
    brand: "Grok",
    defaultCategory: "Grok",
    localPrefix: "grok_",
    fixedCountry: "US",
    defaultCountry: "US",
    allowedCountries: ["US"],
    preflightToken: false,
  },
};

export const CARD_PRODUCT_KEYS = Object.keys(CARD_PRODUCTS) as CardProduct[];

export function isCardProduct(value: unknown): value is CardProduct {
  return typeof value === "string" && value in CARD_PRODUCTS;
}

export function cardProductLabel(product: string | null | undefined) {
  return isCardProduct(product) ? CARD_PRODUCTS[product].label : CARD_PRODUCTS.gpt.label;
}

const X_BARE = /^(?:basic|premium|premium_plus)_(?:monthly|yearly)$/;
// 2026-10-19 Grok 改名 Plus / Premium / Super / Ultra。裸 premium_* 归 X，所以裸键这里不认 premium。
// lite / heavy / monthly / yearly 是改名前的旧键。
const GROK_BARE = /^(?:(?:plus|super|ultra|lite|heavy)_)?(?:monthly|yearly)$/;
const GROK_ANY = /^(?:(?:plus|premium|super|ultra|lite|heavy)_)?(?:monthly|yearly)$/;

/**
 * Grok 首月半价是本站虚拟档位：正价键 + _half（grok_premium_monthly_half），后缀和 GPT 的 plus_half 统一。
 * 卡台没有这种档位，发码按正价键发；码上记半价键，兑换前只放行首月报价在原价一半以内的账号。
 * Grok 只给月付 Premium / Super / Ultra 首月五折，Plus 和年付没有。
 */
export const GROK_HALF_SUFFIX = "_half";
const GROK_HALF_BASES = new Set(["grok_premium_monthly", "grok_super_monthly", "grok_ultra_monthly"]);

function bareKey(planKey: string) {
  // 地区变体 x_premium_monthly:us 只看冒号前面。
  return planKey.trim().toLowerCase().split(":")[0] ?? "";
}

/**
 * plan_key → 产品线。本站 plan_key 带前缀，卡台 preview 回的是裸键：
 * 裸 premium_* 按 X 算（和 danew 一致），要判 Grok 得先拿到 preview 里的 product。
 */
export function productOfPlanKey(planKey: string | null | undefined): CardProduct {
  const key = bareKey(String(planKey || ""));
  if (isGrokHalfPlanKey(key)) return "grok";
  if (key.startsWith("grok_") && GROK_ANY.test(key.slice(5))) return "grok";
  if (key.startsWith("x_") && X_BARE.test(key.slice(2))) return "x";
  if (X_BARE.test(key)) return "x";
  if (GROK_BARE.test(key)) return "grok";
  return "gpt";
}

/** 本站 Grok 半价键（grok_premium_monthly_half 这种）。 */
export function isGrokHalfPlanKey(planKey: string | null | undefined) {
  const key = bareKey(String(planKey || ""));
  return key.endsWith(GROK_HALF_SUFFIX) && GROK_HALF_BASES.has(key.slice(0, -GROK_HALF_SUFFIX.length));
}

/** 半价键去掉 _half 拿到正价键；不是半价键原样返回。 */
export function grokFullPricePlanKey(planKey: string) {
  return isGrokHalfPlanKey(planKey) ? bareKey(planKey).slice(0, -GROK_HALF_SUFFIX.length) : planKey;
}

/** 正价 Grok 档位对应的半价键；这一档没有首月优惠时返回空串。 */
export function grokHalfPlanKey(planKey: string) {
  const key = bareKey(planKey);
  return GROK_HALF_BASES.has(key) ? `${key}${GROK_HALF_SUFFIX}` : "";
}

export const GROK_HALF_LABEL = "（首月半价）";

/** 半价档位的展示名补上「（首月半价）」；管理员改过名、已经带了就不动。 */
export function halfPlanDisplayName(planKey: string | null | undefined, name: string) {
  const text = name.trim();
  if (!isGrokHalfPlanKey(planKey) || !text || text.includes("首月半价")) return text;
  return `${text}${GROK_HALF_LABEL}`;
}

/**
 * 后台列表上把「（首月半价）」从名字里拿出来，改成单独的标签。
 * 有档位键就按键判断；只有名字（订单、提卡单的名字快照）就看名字结尾。
 */
export function splitHalfPlanName(name: string, planKey?: string | null) {
  const text = name.trim();
  const tagged = text.endsWith(GROK_HALF_LABEL);
  return {
    name: tagged ? text.slice(0, -GROK_HALF_LABEL.length).trim() : text,
    half: tagged || isGrokHalfPlanKey(planKey),
  };
}

/**
 * 同步 Grok 目录时，给每个有首月优惠的月付档位生成一行半价档位：发码用正价键，可售状态跟正价行。
 * 排在正价行后面（同 sort_order，键排序靠后）。
 */
export function withGrokHalfPlans<
  T extends { key: string; upstreamKey: string; name: string; raw: unknown },
>(plans: T[]): T[] {
  return plans.flatMap((plan) => {
    const half = grokHalfPlanKey(plan.key);
    if (!half) return [plan];
    return [
      plan,
      {
        ...plan,
        key: half,
        name: halfPlanDisplayName(half, plan.name),
        raw: { ...(plan.raw && typeof plan.raw === "object" ? plan.raw : {}), half_of: plan.key },
      },
    ];
  });
}

/**
 * 裸键 premium_monthly / premium_yearly 在 X 和 Grok 里同名，光看键分不出来。
 * 不是本站发出的卡、卡台 preview 又没给 product 时，不能猜——猜错了会让买家填错凭证。
 */
export function isAmbiguousBareKey(planKey: string | null | undefined) {
  return /^premium_(?:monthly|yearly)$/.test(bareKey(String(planKey || "")));
}

/** 卡台 preview 的 product 字段优先，没有再按键推。 */
export function resolveCardProduct(
  upstreamProduct: string | null | undefined,
  planKey: string | null | undefined,
): CardProduct {
  const named = String(upstreamProduct || "").trim().toLowerCase();
  if (named === "chatgpt" || named === "openai") return "gpt";
  if (isCardProduct(named)) return named;
  return productOfPlanKey(planKey);
}

/** 套餐名补上产品名：「Premium 月付」→「Grok Premium 月付」；已经带了就不动。 */
export function brandedPlanName(product: CardProduct, name: string) {
  const brand = CARD_PRODUCTS[product].brand;
  const text = name.trim();
  if (!brand || !text) return text;
  const pattern = new RegExp(`(^|[^A-Za-z])${brand}([^A-Za-z]|$)`, "i");
  return pattern.test(text) ? text : `${brand} ${text}`;
}

/** 卡台注册表裸键 → 本站 plan_key。 */
export function localPlanKey(product: CardProduct, bare: string) {
  const key = bare.trim();
  const prefix = CARD_PRODUCTS[product].localPrefix;
  if (!prefix || key.toLowerCase().startsWith(prefix)) return key;
  return `${prefix}${key}`;
}

/**
 * 本站 plan_key → 发给卡台 POST /gpt-direct/cdks 的 plan。
 * X 发裸键（卡台按 payment_country 区分），Grok 必须带 grok_ 前缀、半价键换回正价键，GPT 原样。
 */
export function upstreamIssuePlanKey(product: CardProduct, planKey: string) {
  const key = bareKey(planKey);
  if (product === "x") return key.replace(/^x_/, "");
  if (product === "grok") {
    // 半价档位卡台没有，按正价键发码。
    const full = grokFullPricePlanKey(key);
    return full.startsWith("grok_") ? full : `grok_${full}`;
  }
  return planKey.trim();
}

/** 卡台给了就用卡台的；Grok 固定 US，X 缺省 JP，GPT 缺省空串（菲区）。 */
export function issuePaymentCountry(product: CardProduct, country: string | null | undefined) {
  const spec = CARD_PRODUCTS[product];
  if (spec.fixedCountry) return spec.fixedCountry;
  const normalized = String(country || "").trim().toUpperCase();
  return normalized || spec.defaultCountry;
}

/** 卡台下发的地区按产品收窄。X 一个都不剩时回落 JP。 */
export function scopePaymentRegions<T extends { country: string; currency: string }>(
  product: CardProduct,
  regions: T[],
): Array<{ country: string; currency: string }> {
  const spec = CARD_PRODUCTS[product];
  if (product === "grok") return [{ country: "US", currency: "USD" }];
  if (!spec.allowedCountries.length) return regions;
  const allowed = new Set(spec.allowedCountries);
  const scoped = regions.filter((region) => allowed.has(region.country));
  return scoped.length ? scoped : [{ country: spec.defaultCountry, currency: "JPY" }];
}

export type CredentialCheck = { ok: true; session: string } | { ok: false; error: string };

const SSO_COOKIE = /(?:^|;\s*)sso(?:-rw)?=[^;\s]+/;

/** Grok 登录态：整段 cookie（含 sso=）或只粘了 sso 的值。 */
export function grokCredential(raw: string): CredentialCheck {
  const text = String(raw || "").trim();
  const invalid = { ok: false as const, error: "请粘贴 grok.com 的 sso cookie（形如 sso=eyJ...）" };
  if (!text || text.length > 8192 || /[\r\n\0]/.test(text)) return invalid;
  if (!text.startsWith("{") && SSO_COOKIE.test(text)) return { ok: true, session: text };
  if (/^[A-Za-z0-9._~%+/-]{16,4096}={0,2}$/.test(text)) return { ok: true, session: `sso=${text}` };
  return invalid;
}

const X_TOKEN = /^[a-zA-Z0-9._%~-]{16,512}$/;

/** X 登录态：JSON，含 billing_email，加 cookieHeader（含 auth_token 和 ct0）或单独的 auth_token / ct0。 */
export function xCredential(raw: string): CredentialCheck {
  const text = String(raw || "").trim();
  const invalid = {
    ok: false as const,
    error: "请粘贴 X 登录凭证 JSON：需要 billing_email，以及 auth_token 和 ct0（或含这两项的 cookieHeader）",
  };
  if (!text || text.length > 32768 || /\0/.test(text)) return invalid;
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid;
    value = parsed as Record<string, unknown>;
  } catch {
    return invalid;
  }
  const email = String(value.billing_email || value.billingEmail || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "X 凭证缺少有效的 billing_email（账单邮箱）" };
  }
  const header = value.cookieHeader;
  if (
    typeof header === "string" &&
    /auth_token=/.test(header) &&
    /ct0=/.test(header) &&
    !/[\r\n\0]/.test(header)
  ) {
    return { ok: true, session: text };
  }
  if (X_TOKEN.test(String(value.auth_token || "")) && X_TOKEN.test(String(value.ct0 || ""))) {
    return { ok: true, session: text };
  }
  return invalid;
}

/** X 凭证里的账单邮箱，兑换单上记这个。 */
export function xCredentialEmail(session: string) {
  try {
    const value = JSON.parse(session) as Record<string, unknown>;
    return String(value.billing_email || value.billingEmail || "").trim();
  } catch {
    return "";
  }
}

/** 按产品同步结果的一句话：「ChatGPT 12 个 · X 订阅码 6 个 · Grok 失败：…」。后台提示和同步日志共用。 */
export function summarizeProductSync(
  rows: Array<{ product: string; count: number; created?: number; skipped?: string; error?: string }>,
) {
  return rows
    .map((row) => {
      const label = cardProductLabel(row.product);
      if (row.skipped) return `${label} 跳过：${row.skipped}`;
      if (row.error) return `${label} 失败：${row.error}`;
      return `${label} ${row.count} 个${row.created ? `（新拉到 ${row.created} 个）` : ""}`;
    })
    .join(" · ");
}

/** 兑换凭证按产品规范化。GPT 的 Session 格式在入口已经核过，这里原样放行。 */
export function redeemCredential(product: CardProduct, raw: string): CredentialCheck {
  if (product === "grok") return grokCredential(raw);
  if (product === "x") return xCredential(raw);
  const text = String(raw || "").trim();
  return text ? { ok: true, session: text } : { ok: false, error: "请粘贴 ChatGPT Session" };
}

/**
 * 店铺前台的产品线排列。
 * - 排序：ChatGPT → X → Grok，产品线内按卡台顺序。卡台各线的 sort_order 各自从 1 起，不分开会穿插。
 * - 分类：店里同时卖不止一条线时，没填分类的 ChatGPT 卡密归到「ChatGPT」，
 *   否则分类栏只有「X 订阅码」「Grok」，买家筛不出 ChatGPT。只卖 ChatGPT 时保持原样。
 */
export function arrangeStorefrontPlans<
  T extends { product?: string | null; category: string; sortOrder: number; fulfillmentKind?: string | null },
>(rows: T[]): T[] {
  const productOf = (row: T): CardProduct => (isCardProduct(row.product) ? row.product : "gpt");
  const multi = new Set(rows.map(productOf)).size > 1;
  return rows.map((row) => {
    const product = productOf(row);
    const index = CARD_PRODUCT_KEYS.indexOf(product);
    const uncategorizedGpt =
      multi && product === "gpt" && !row.category.trim() && row.fulfillmentKind !== "local_account";
    return {
      ...row,
      category: uncategorizedGpt ? CARD_PRODUCTS.gpt.label : row.category,
      sortOrder: index * 100_000 + row.sortOrder,
    };
  });
}
