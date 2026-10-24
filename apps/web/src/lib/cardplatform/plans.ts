import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts, platformPlans } from "@/db/schema";
import { getDefaultCardplatformClient } from "@/lib/cardplatform/config";
import { supportsPaymentCountry } from "./protocol";
import {
  parseRegionWhitelist,
  paymentRegionsSettingKey,
  planRegionCapable,
  REGION_WHITELIST_SETTING,
  variantPlanKey,
} from "@/lib/cardplatform/regions";
import { CARD_PRODUCT_KEYS, CARD_PRODUCTS, type CardProduct } from "./product";
import type {
  CardplatformClient,
  CardplatformPaymentRegion,
  CardplatformPlan,
} from "./client";
import { bootDb, getSetting, setSetting } from "@/lib/config";
import { isLocalAccountPlan } from "@/lib/finished-account-core";

export type ProductSyncResult = {
  product: CardProduct;
  count: number;
  created: number;
  updated: number;
  regions: string[];
  variantsCreated: number;
  /** 没同步：当前卡台不支持这条产品线。该线套餐已停售。 */
  skipped?: string;
  error?: string;
};

/**
 * 三条产品线各拉各的目录、各自复位可售标记：X 拉失败不能把 GPT 下架。
 * 全部失败才抛错；顶层 count / created 等字段是各线合计，老调用方照旧能用。
 */
export async function syncDefaultCardplatformPlans() {
  await bootDb();
  const { account, client } = await getDefaultCardplatformClient();
  // 环境变量账户（id 0）按旧台协议处理；Avanfinity 没有付款地区。
  const protocol = "protocol" in account ? account.protocol : "";
  const regionSupported = account.id === 0 || supportsPaymentCountry(protocol);
  const whitelist = new Set(
    parseRegionWhitelist(await getSetting(REGION_WHITELIST_SETTING, "US,CL")),
  );

  const products: ProductSyncResult[] = [];
  for (const product of CARD_PRODUCT_KEYS) {
    // X / Grok 发码必须带 payment_country，不支持地区的卡台发不了，同步进来也卖不掉。
    if (product !== "gpt" && !regionSupported) {
      await markProductUnsellable(product);
      products.push({
        ...emptyResult(product),
        skipped: "当前默认卡台不支持指定付款地区，暂不能售卖",
      });
      continue;
    }
    try {
      products.push(
        await syncProductPlans({ product, client, accountId: account.id, regionSupported, whitelist }),
      );
    } catch (error) {
      products.push({
        ...emptyResult(product),
        error: error instanceof Error ? error.message : "套餐同步失败",
      });
    }
  }

  const attempted = products.filter((item) => !item.skipped);
  const succeeded = attempted.filter((item) => !item.error);
  if (attempted.length > 0 && succeeded.length === 0) {
    throw new Error(attempted.map((item) => `${CARD_PRODUCTS[item.product].label}：${item.error}`).join("；"));
  }
  if (account.id > 0) {
    const now = new Date().toISOString();
    const errors = attempted
      .filter((item) => item.error)
      .map((item) => `${CARD_PRODUCTS[item.product].label}：${item.error}`);
    await db
      .update(cardplatformAccounts)
      .set({
        lastHealthAt: now,
        lastPlansSyncAt: now,
        lastError: errors.join("；"),
        updatedAt: now,
      })
      .where(eq(cardplatformAccounts.id, account.id));
  }

  const gpt = products.find((item) => item.product === "gpt");
  return {
    count: sum(products, "count"),
    created: sum(products, "created"),
    updated: sum(products, "updated"),
    variantsCreated: sum(products, "variantsCreated"),
    /** GPT 的地区，兼容老字段 */
    regions: gpt?.regions ?? [],
    products,
  };
}

function emptyResult(product: CardProduct): ProductSyncResult {
  return { product, count: 0, created: 0, updated: 0, regions: [], variantsCreated: 0 };
}

function sum(rows: ProductSyncResult[], field: "count" | "created" | "updated" | "variantsCreated") {
  return rows.reduce((total, row) => total + row[field], 0);
}

async function markProductUnsellable(product: CardProduct) {
  await db
    .update(platformPlans)
    .set({ cardplatformSellable: false, updatedAt: new Date().toISOString() })
    .where(
      and(eq(platformPlans.fulfillmentKind, "cardplatform"), eq(platformPlans.product, product)),
    );
}

/**
 * 主行的付款地区，固定不变：GPT 菲区（空串）、X 日区、Grok 美区。
 * 不能跟着卡台下发的地区漂移——主行改了地区，定好的价格、在途订单的地区就全对不上了。
 * 卡台暂时不开主行地区时，由 baseSellable 让主行停售。
 */
function baseCountryFor(product: CardProduct) {
  const spec = CARD_PRODUCTS[product];
  return spec.fixedCountry || spec.defaultCountry;
}

/** 主行能不能卖：GPT 菲区始终可用；X / Grok 要卡台本轮确实开了主行地区。 */
function baseSellable(product: CardProduct, baseCountry: string, regions: CardplatformPaymentRegion[]) {
  if (!baseCountry) return true;
  return regions.some((region) => region.country === baseCountry);
}

async function syncProductPlans(input: {
  product: CardProduct;
  client: CardplatformClient;
  accountId: number;
  regionSupported: boolean;
  whitelist: Set<string>;
}): Promise<ProductSyncResult> {
  const { product, client, accountId, whitelist } = input;
  const spec = CARD_PRODUCTS[product];
  const { plans, regions } = await client.getPlansWithRegions(45_000, product);
  const activeRegions = input.regionSupported ? regions : [];
  const baseCountry = baseCountryFor(product);
  const baseOpen = baseSellable(product, baseCountry, activeRegions);
  const now = new Date().toISOString();

  await setSetting(
    paymentRegionsSettingKey(accountId, product),
    JSON.stringify({ syncedAt: now, regions: activeRegions }),
  );

  let created = 0;
  let updated = 0;
  let variantsCreated = 0;
  await db.transaction(async (tx) => {
    await tx
      .update(platformPlans)
      .set({ cardplatformSellable: false, updatedAt: now })
      .where(
        and(eq(platformPlans.fulfillmentKind, "cardplatform"), eq(platformPlans.product, product)),
      );
    for (const plan of plans) {
      // Grok 只有美区一个价，不做地区版。
      const regionCapable = product === "grok" ? false : planRegionCapable(plan);
      const existing = await tx.query.platformPlans.findFirst({
        where: eq(platformPlans.planKey, plan.key),
      });
      if (existing) {
        if (isLocalAccountPlan(existing)) continue;
        await tx
          .update(platformPlans)
          .set({
            name: existing.name || plan.name,
            sortOrder: plan.sortOrder,
            cardplatformSellable: plan.enabled && baseOpen,
            regionCapable,
            product,
            ...productColumns(product, plan, existing.category, baseCountry),
            // GPT 老行一次性回填分组键，幂等。
            ...(existing.basePlanKey ? {} : { basePlanKey: plan.key, upstreamPlanKey: plan.upstreamKey }),
            cardplatformRawJson: JSON.stringify(plan.raw),
            syncedAt: now,
            updatedAt: now,
          })
          .where(eq(platformPlans.id, existing.id));
        updated += 1;
      } else {
        await tx.insert(platformPlans).values({
          planKey: plan.key,
          basePlanKey: plan.key,
          upstreamPlanKey: plan.upstreamKey,
          product,
          paymentCountry: baseCountry,
          category: spec.defaultCategory,
          regionCapable,
          name: plan.name,
          sortOrder: plan.sortOrder,
          enabled: false,
          cardplatformSellable: plan.enabled && baseOpen,
          cardplatformRawJson: JSON.stringify(plan.raw),
          syncedAt: now,
        });
        created += 1;
      }

      if (!regionCapable) continue;
      const displayName = existing?.name || plan.name;
      for (const region of activeRegions) {
        // 主行已经是这个地区（X 的日区），不再出一个变体。
        if (region.country === baseCountry) continue;
        const key = variantPlanKey(plan.key, region.country);
        const variant = await tx.query.platformPlans.findFirst({
          where: eq(platformPlans.planKey, key),
        });
        if (variant) {
          await tx
            .update(platformPlans)
            .set({
              name: displayName,
              cardplatformSellable: plan.enabled,
              sortOrder: plan.sortOrder,
              product,
              upstreamPlanKey: plan.upstreamKey,
              cardplatformRawJson: JSON.stringify(plan.raw),
              syncedAt: now,
              updatedAt: now,
            })
            .where(eq(platformPlans.id, variant.id));
        } else if (whitelist.has(region.country)) {
          await tx.insert(platformPlans).values({
            planKey: key,
            basePlanKey: plan.key,
            upstreamPlanKey: plan.upstreamKey,
            product,
            paymentCountry: region.country,
            category: spec.defaultCategory,
            regionCapable: true,
            name: displayName,
            sortOrder: plan.sortOrder,
            enabled: false,
            globalCostPriceCents: 0,
            cardplatformSellable: plan.enabled,
            cardplatformRawJson: JSON.stringify(plan.raw),
            syncedAt: now,
          });
          variantsCreated += 1;
        }
      }
    }
  });
  return {
    product,
    count: plans.length,
    created,
    updated,
    regions: activeRegions.map((region) => region.country),
    variantsCreated,
  };
}

/**
 * X / Grok 主行每轮都按卡台规则改正上游键和地区：老库里可能有被当成 GPT 存下来的
 * x_* / grok_* 行，上游键还是带前缀的、地区是空串（菲区），原样发码必然被拒。
 * GPT 行保持原样，管理员可能手动改过。
 */
function productColumns(
  product: CardProduct,
  plan: CardplatformPlan,
  category: string,
  baseCountry: string,
) {
  if (product === "gpt") return {};
  return {
    basePlanKey: plan.key,
    upstreamPlanKey: plan.upstreamKey,
    paymentCountry: baseCountry,
    ...(category.trim() ? {} : { category: CARD_PRODUCTS[product].defaultCategory }),
  };
}
