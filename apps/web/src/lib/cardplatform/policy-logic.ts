import { canonicalCardIssuer } from "./issuer";
import type { DirectCardSelectPref } from "./client";

export type SiteRedeemPolicy = {
  enabled: boolean;
  noAutoCardSwitch: boolean;
  strictCardPreference: boolean;
  autoOpenWhenNoCard: boolean;
  maxNewAccountsPerCard: number;
  maxCardsPerTask: number;
  failCooldownHours: number;
  issuingArea: string;
  holderFirst: string;
  holderLast: string;
  productCode: string;
  issuer: string;
};

export type CardSelectionRule = {
  planKey: string;
  displayName: string;
  binPrefix: string;
  channel: string;
  enabled: boolean;
};

export type CachedCardProduct = {
  productCode: string;
  issuer: string;
  bin: string;
  network: string;
  issuingArea: string;
  scene: string;
  description: string;
  enabled: boolean;
  suspendedAt: string;
  syncedAt: string;
};

export function defaultSiteRedeemPolicy(): SiteRedeemPolicy {
  return {
    enabled: false,
    noAutoCardSwitch: true,
    strictCardPreference: true,
    autoOpenWhenNoCard: true,
    maxNewAccountsPerCard: 4,
    maxCardsPerTask: 3,
    failCooldownHours: 24,
    issuingArea: "United States",
    holderFirst: "GPT",
    holderLast: "Direct",
    productCode: "",
    issuer: "",
  };
}

export function cardProductUsable(
  code: string,
  products: Array<Pick<CachedCardProduct, "productCode" | "enabled" | "suspendedAt">>,
) {
  const key = code.trim();
  if (!key) return false;
  if (products.length === 0) return true;
  const match = products.find(
    (item) => item.productCode.trim().toUpperCase() === key.toUpperCase(),
  );
  return Boolean(match?.enabled && !match.suspendedAt.trim());
}

function resolveIssuerForRule(
  rule: CardSelectionRule,
  products: Array<Pick<CachedCardProduct, "productCode" | "issuer">>,
) {
  const fromRule = canonicalCardIssuer(rule.channel);
  if (fromRule) return fromRule;
  const product = products.find(
    (item) =>
      item.productCode.trim().toUpperCase() === rule.planKey.trim().toUpperCase(),
  );
  return canonicalCardIssuer(product?.issuer || "") || "one";
}

export function buildSelectPriority(
  rules: CardSelectionRule[],
  products: Array<Pick<CachedCardProduct, "productCode" | "issuer" | "enabled" | "suspendedAt">>,
): DirectCardSelectPref[] {
  const out: DirectCardSelectPref[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const key = rule.planKey.trim();
    if (!key || !cardProductUsable(key, products)) continue;
    const issuer = resolveIssuerForRule(rule, products);
    const dup = `${issuer}|product|${key}`;
    if (seen.has(dup)) continue;
    seen.add(dup);
    out.push({ issuer, segment_type: "product", segment_key: key });
    if (out.length >= 12) break;
  }
  return out;
}

export function firstUsableCardPref(
  policy: SiteRedeemPolicy,
  rules: CardSelectionRule[],
  products: Array<Pick<CachedCardProduct, "productCode" | "issuer" | "enabled" | "suspendedAt">>,
) {
  const code = policy.productCode.trim();
  if (code && cardProductUsable(code, products)) {
    let issuer = canonicalCardIssuer(policy.issuer);
    if (!issuer) {
      const product = products.find(
        (item) => item.productCode.trim().toUpperCase() === code.toUpperCase(),
      );
      issuer = canonicalCardIssuer(product?.issuer || "");
    }
    return {
      issuer: issuer || "one",
      segmentType: "product",
      segmentKey: code,
    };
  }
  const prefs = buildSelectPriority(rules, products);
  if (!prefs[0]) return null;
  return {
    issuer: prefs[0].issuer,
    segmentType: prefs[0].segment_type || "product",
    segmentKey: prefs[0].segment_key,
  };
}

export function applyRedeemCardPolicy(
  body: Record<string, unknown>,
  policy: SiteRedeemPolicy,
  hasRules: boolean,
  excludeCardIds: number[],
) {
  if (policy.enabled && !("no_auto_card_switch" in body)) {
    body.no_auto_card_switch = policy.noAutoCardSwitch;
  }
  if (!("strict_card_preference" in body) && (policy.enabled || hasRules)) {
    body.strict_card_preference = policy.enabled
      ? policy.strictCardPreference
      : true;
  }
  if (!("exclude_card_ids" in body) && excludeCardIds.length > 0) {
    body.exclude_card_ids = excludeCardIds;
  }
  return body;
}
