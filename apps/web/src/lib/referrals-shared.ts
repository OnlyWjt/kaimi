// 邀请返券几个模块共用的小件：类型、错误、设置行、商品名。
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  agentReferralSettings,
  agentStorefronts,
  platformPlans,
} from "@/db/schema";
import { resolveProductName, rowToSettings } from "@/lib/agent-storefront-config";
import type { AuthSession } from "@/lib/auth";
import { planNameWithRegion } from "@/lib/cardplatform/regions";
import { decryptSecret, hashLookupValue } from "@/lib/crypto";
import {
  REFERRAL_DEFAULTS,
  type ReferralRewards,
  describeReferralRewards,
  normalizeReferralEmail,
} from "@/lib/referral-core";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Conn = typeof db | Tx;
export type Actor = Pick<AuthSession, "id" | "role">;

export class ReferralError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 付过款的状态。refunding 还在等平台退，先当付过。 */
export const PAID_STATUSES = ["paid", "manual", "refunding", "refunded"];

export function referralEmailHash(email: string) {
  return hashLookupValue(normalizeReferralEmail(email));
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeDecrypt(value: string) {
  try {
    return decryptSecret(value);
  } catch {
    return "";
  }
}

export async function settingsRow(agentId: number, conn: Conn = db) {
  const [row] = await conn
    .select()
    .from(agentReferralSettings)
    .where(eq(agentReferralSettings.agentId, agentId))
    .limit(1);
  return row ?? null;
}

export function effectiveSettings(row: typeof agentReferralSettings.$inferSelect | null) {
  return {
    enabled: Boolean(row?.enabled),
    firstEnabledAt: row?.firstEnabledAt ?? null,
    couponValidDays: row?.couponValidDays ?? REFERRAL_DEFAULTS.couponValidDays,
    coolingDays: row?.coolingDays ?? REFERRAL_DEFAULTS.coolingDays,
    minOrderCents: row?.minOrderCents ?? REFERRAL_DEFAULTS.minOrderCents,
    monthlyCap: row?.monthlyCap ?? REFERRAL_DEFAULTS.monthlyCap,
    disabledByAdminAt: row?.disabledByAdminAt ?? null,
  };
}

/** 只给买家看的商品名，按 plan_key 查；下架了的也要能显示（券上的快照）。 */
export async function planDisplayNames(agentId: number, planKeys: string[]) {
  const keys = [...new Set(planKeys)];
  if (!keys.length) return new Map<string, string>();
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      basePlanKey: platformPlans.basePlanKey,
      name: platformPlans.name,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
    })
    .from(platformPlans)
    .where(inArray(platformPlans.planKey, keys));
  const storefront = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agentId),
  });
  const names = rowToSettings(storefront).productNames;
  return new Map(
    rows.map((row) => [
      row.planKey,
      planNameWithRegion(
        resolveProductName(row.basePlanKey || row.planKey, row.name, names).zh,
        row.regionCapable,
        row.paymentCountry,
        row.regionLabel,
        "paren",
      ),
    ]),
  );
}

export function describeRewards(rewards: ReferralRewards, names: Map<string, string>) {
  return describeReferralRewards(
    Object.entries(rewards).map(([planKey, amountCents]) => ({
      planName: names.get(planKey) || planKey,
      amountCents,
    })),
  );
}
