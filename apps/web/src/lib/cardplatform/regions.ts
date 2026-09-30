/**
 * 付款地区的纯函数：命名、排序、分组。
 * 不能 import 数据库，客户端组件也要引用。
 *
 * 默认区是菲区（菲律宾），对应卡台 payment_country 为空串：发码时不传这个字段。
 */

export type RegionDisplay = {
  /** 卡台 payment_country。空串 = 菲区。 */
  country: string;
  code: string;
  zh: string;
  en: string;
};

const KNOWN_REGIONS: Record<string, { code: string; zh: string; en: string }> = {
  "": { code: "PH", zh: "菲区", en: "Philippines" },
  US: { code: "US", zh: "美区", en: "United States" },
  CL: { code: "CL", zh: "智利区", en: "Chile" },
};

export function normalizePaymentCountry(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

/** 地区中文名、英文名与两位短码。regionLabel 非空时只覆盖中文名。 */
export function regionDisplay(country: string, regionLabel = ""): RegionDisplay {
  const normalized = normalizePaymentCountry(country);
  const known = KNOWN_REGIONS[normalized];
  const label = regionLabel.trim();
  if (known) {
    return { country: normalized, code: known.code, zh: label || known.zh, en: known.en };
  }
  return {
    country: normalized,
    code: normalized,
    zh: label || `${normalized}区`,
    en: normalized,
  };
}

/** 「Plus · 美区」或「Plus（美区）」。没有地区概念（点数档、成品号）时返回原名。 */
export function planWithRegion(
  name: string,
  country: string,
  regionLabel = "",
  style: "dot" | "paren" = "dot",
) {
  const region = regionDisplay(country, regionLabel);
  if (!region.country && !regionLabel.trim()) {
    // 空串是菲区。调用方传了 regionLabel 才说明这是一个「有地区」的套餐；
    // 没传时无法区分「菲区」和「点数档」，交给 regionCapable 的调用方决定。
  }
  const text = region.zh;
  return style === "paren" ? `${name}（${text}）` : `${name} · ${text}`;
}

/** 有地区概念的套餐才拼地区；否则返回原名。 */
export function planNameWithRegion(
  name: string,
  regionCapable: boolean,
  country: string,
  regionLabel = "",
  style: "dot" | "paren" = "dot",
) {
  if (!regionCapable) return name;
  return planWithRegion(name, country, regionLabel, style);
}

export type RegionSpec = {
  planKey: string;
  paymentCountry: string;
  sortOrder: number;
};

/** 菲区永远第一，其余按 sortOrder，再按地区码字母序。 */
export function sortRegionSpecs<T extends RegionSpec>(specs: T[]): T[] {
  return [...specs].sort((a, b) => {
    const aDefault = normalizePaymentCountry(a.paymentCountry) === "" ? 0 : 1;
    const bDefault = normalizePaymentCountry(b.paymentCountry) === "" ? 0 : 1;
    if (aDefault !== bDefault) return aDefault - bDefault;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return normalizePaymentCountry(a.paymentCountry).localeCompare(
      normalizePaymentCountry(b.paymentCountry),
    );
  });
}

export type PlanGroupInput = {
  planKey: string;
  basePlanKey: string;
  name: string;
  paymentCountry: string;
  regionLabel: string;
  regionCapable: boolean;
  sortOrder: number;
};

export type PlanGroup<T extends PlanGroupInput> = {
  baseKey: string;
  /** 组的代表行：菲区行优先，没有就取排序第一行。名字、封面、分类都取它。 */
  primary: T;
  plans: T[];
};

/** 按基础套餐分组。没有 base_plan_key 的老行自成一组。 */
export function groupPlansByBase<T extends PlanGroupInput>(plans: T[]): PlanGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const plan of plans) {
    const baseKey = plan.basePlanKey.trim() || plan.planKey;
    const list = groups.get(baseKey) ?? [];
    list.push(plan);
    groups.set(baseKey, list);
  }
  const result: PlanGroup<T>[] = [];
  for (const [baseKey, list] of groups) {
    const sorted = sortRegionSpecs(list);
    const primary = sorted.find((plan) => !normalizePaymentCountry(plan.paymentCountry)) ?? sorted[0];
    result.push({ baseKey, primary, plans: sorted });
  }
  result.sort((a, b) => {
    if (a.primary.sortOrder !== b.primary.sortOrder) return a.primary.sortOrder - b.primary.sortOrder;
    return a.baseKey.localeCompare(b.baseKey);
  });
  return result;
}

/** 同组在售地区数 ≥ 2 时，下单必须带 regionConfirmed。 */
export function regionConfirmationRequired(groupSize: number) {
  return groupSize >= 2;
}

/** 白名单存成 "US,CL"。非法条目丢掉，重复的合并。 */
export function parseRegionWhitelist(value: string | null | undefined) {
  const seen = new Set<string>();
  for (const part of String(value || "").split(",")) {
    const country = part.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) seen.add(country);
  }
  return [...seen];
}

export function formatRegionWhitelist(countries: string[]) {
  return parseRegionWhitelist(countries.join(",")).join(",");
}

export const REGION_WHITELIST_SETTING = "cardplatform_region_whitelist";

export function paymentRegionsSettingKey(accountId: number) {
  return `cardplatform_payment_regions_${accountId}`;
}

/**
 * 这个套餐能不能做地区版。
 * 点数档按 PHP 计价，续费档平台后续全部下架，两者都不生成变体。
 * registry 里拿不到标记时，按 key 和名字里的 renew / 续费 兜底。
 */
export function planRegionCapable(plan: {
  key: string;
  name: string;
  raw: unknown;
}) {
  const raw = typeof plan.raw === "object" && plan.raw !== null
    ? (plan.raw as Record<string, unknown>)
    : {};
  const registry = typeof raw.registry === "object" && raw.registry !== null
    ? (raw.registry as Record<string, unknown>)
    : {};
  if (registry.is_credit === true) return false;
  if (registry.requires_active_subscription === true) return false;
  const text = `${plan.key} ${plan.name}`.toLowerCase();
  if (/renew|续费/.test(text)) return false;
  return true;
}

/** 地区变体的 plan_key：plus:us。 */
export function variantPlanKey(baseKey: string, country: string) {
  return `${baseKey}:${country.trim().toLowerCase()}`;
}
