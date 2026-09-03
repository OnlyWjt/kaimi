import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accountCardProductCache,
  accountCardSelectionRules,
} from "@/db/schema";
import { getSetting, setSetting } from "@/lib/config";
import type { CardplatformClient } from "./client";
import { listActiveBlockedCardIds } from "./health";
import {
  applyRedeemCardPolicy,
  buildSelectPriority,
  defaultSiteRedeemPolicy,
  firstUsableCardPref,
  type SiteRedeemPolicy,
  type CardSelectionRule,
} from "./policy-logic";

export {
  applyRedeemCardPolicy,
  buildSelectPriority,
  cardProductUsable,
  defaultSiteRedeemPolicy,
  firstUsableCardPref,
} from "./policy-logic";
export type {
  CachedCardProduct,
  CardSelectionRule,
  SiteRedeemPolicy,
} from "./policy-logic";

function policyKey(accountId: number) {
  return accountId > 0 ? `site_redeem_policy_${accountId}` : "site_redeem_policy";
}

function normalizePolicy(raw: Partial<SiteRedeemPolicy>, inherited = false): SiteRedeemPolicy {
  const policy = { ...defaultSiteRedeemPolicy(), ...raw };
  if (inherited) {
    policy.productCode = "";
    policy.issuer = "";
  }
  if (policy.maxNewAccountsPerCard <= 0) policy.maxNewAccountsPerCard = 4;
  if (policy.maxCardsPerTask <= 0) policy.maxCardsPerTask = 3;
  if (policy.failCooldownHours <= 0) policy.failCooldownHours = 24;
  policy.productCode = policy.productCode.trim();
  policy.issuer = policy.issuer.trim().toLowerCase();
  policy.issuingArea = policy.issuingArea.trim();
  policy.holderFirst = policy.holderFirst.trim();
  policy.holderLast = policy.holderLast.trim();
  return policy;
}

export async function loadSiteRedeemPolicy(accountId: number): Promise<SiteRedeemPolicy> {
  const scoped = await getSetting(policyKey(accountId));
  if (scoped.trim()) {
    try {
      return normalizePolicy(JSON.parse(scoped) as Partial<SiteRedeemPolicy>);
    } catch {
      return defaultSiteRedeemPolicy();
    }
  }
  if (accountId > 0) {
    const legacy = await getSetting("site_redeem_policy");
    if (legacy.trim()) {
      try {
        return normalizePolicy(JSON.parse(legacy) as Partial<SiteRedeemPolicy>, true);
      } catch {
        return defaultSiteRedeemPolicy();
      }
    }
  }
  return defaultSiteRedeemPolicy();
}

export async function saveSiteRedeemPolicy(
  accountId: number,
  input: SiteRedeemPolicy,
) {
  const policy = normalizePolicy({
    ...input,
    productCode: "",
    issuer: "",
  });
  await setSetting(policyKey(accountId), JSON.stringify(policy));
  return policy;
}

export async function listSelectionRules(accountId: number) {
  return db
    .select()
    .from(accountCardSelectionRules)
    .where(eq(accountCardSelectionRules.accountId, accountId))
    .orderBy(
      asc(accountCardSelectionRules.sortOrder),
      asc(accountCardSelectionRules.id),
    );
}

export async function listCachedProducts(accountId: number) {
  return db
    .select()
    .from(accountCardProductCache)
    .where(eq(accountCardProductCache.accountId, accountId))
    .orderBy(asc(accountCardProductCache.productCode));
}

export async function issuePrefFromAccount(accountId: number) {
  const [policy, rules, products] = await Promise.all([
    loadSiteRedeemPolicy(accountId),
    listSelectionRules(accountId),
    listCachedProducts(accountId),
  ]);
  return firstUsableCardPref(policy, rules, products);
}

export async function injectRedeemCardPolicy(
  body: Record<string, unknown>,
  accountId: number,
) {
  const [policy, rules, excludeCardIds] = await Promise.all([
    loadSiteRedeemPolicy(accountId),
    listSelectionRules(accountId),
    listActiveBlockedCardIds(accountId),
  ]);
  return applyRedeemCardPolicy(
    body,
    policy,
    rules.some((rule) => rule.enabled && rule.planKey.trim()),
    excludeCardIds,
  );
}

export async function replaceSelectionRules(
  accountId: number,
  rules: CardSelectionRule[],
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(accountCardSelectionRules)
      .where(eq(accountCardSelectionRules.accountId, accountId));
    if (rules.length === 0) return;
    await tx.insert(accountCardSelectionRules).values(
      rules.map((rule, index) => ({
        accountId,
        sortOrder: index + 1,
        planKey: rule.planKey.trim(),
        displayName: rule.displayName.trim() || rule.planKey.trim(),
        binPrefix: rule.binPrefix.trim(),
        channel: rule.channel.trim(),
        enabled: rule.enabled,
      })),
    );
  });
}

export async function syncOwnerDirectCardRules(
  client: CardplatformClient,
  accountId: number,
) {
  const [policy, rules, products] = await Promise.all([
    loadSiteRedeemPolicy(accountId),
    listSelectionRules(accountId),
    listCachedProducts(accountId),
  ]);
  const prefs = buildSelectPriority(rules, products);
  const existing = await client.getCardRules();
  const byProduct = new Map(
    existing.map((rule) => [rule.product.trim().toLowerCase(), rule]),
  );
  for (const product of ["gpt", "claude", "grok"]) {
    const current = byProduct.get(product) ?? {
      product,
      count_failures: true,
      light_max_uses: 5,
      pro20_max_uses: 3,
      auto_switch_on_fail: true,
      max_auto_switches: 2,
      select_mode: "default",
    };
    current.product = product;
    current.select_priority = prefs;
    current.strict_select = prefs.length > 0;
    if (policy.enabled) {
      current.auto_switch_on_fail = !policy.noAutoCardSwitch;
    }
    await client.putCardRule(current);
  }
}

export async function hasEnabledSelectionRules(accountId: number) {
  const rules = await db
    .select()
    .from(accountCardSelectionRules)
    .where(
      and(
        eq(accountCardSelectionRules.accountId, accountId),
        eq(accountCardSelectionRules.enabled, true),
      ),
    );
  return rules.some((rule) => rule.planKey.trim());
}
