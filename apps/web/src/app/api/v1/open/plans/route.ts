import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentStorefronts, platformPlans } from "@/db/schema";
import { enabledPaymentChannels, loadAgentSellablePlans } from "@/lib/agent-catalog";
import {
  resolvePlanCover,
  resolveProductName,
  rowToSettings,
} from "@/lib/agent-storefront-config";
import { planNameWithRegion, regionDisplay } from "@/lib/cardplatform/regions";
import { isApiKeyContext, requireApiKey, type ApiKeyContext } from "@/lib/open-api/auth";
import { openOk } from "@/lib/open-api/respond";
import { getStoreSalesGate } from "@/lib/ops-health";
import { getPublicBaseUrl } from "@/lib/public-url";
import { getMaxOrderQuantity } from "@/lib/store-quantity";

type PlanRow = {
  planKey: string;
  basePlanKey: string;
  paymentCountry: string;
  regionLabel: string;
  regionCapable: boolean;
  regionNote: string;
  description: string;
  category: string;
};

/** 没有地区概念的套餐（点数档、续费档、成品号）region 为 null。 */
function regionFields(row: PlanRow, name: string) {
  const region = row.regionCapable ? regionDisplay(row.paymentCountry, row.regionLabel) : null;
  return {
    plan_key: row.planKey,
    base_plan_key: row.basePlanKey || row.planKey,
    payment_country: row.paymentCountry,
    region: region && {
      code: region.code,
      name: region.zh,
      name_en: region.en,
      note: row.regionNote,
    },
    name,
    display_name: planNameWithRegion(name, row.regionCapable, row.paymentCountry, row.regionLabel),
    description: row.description,
    category: row.category,
  };
}

function absoluteUrl(base: string, url: string) {
  if (!url || !url.startsWith("/") || !base) return url;
  return `${base}${url}`;
}

/** 代理 Key：只列真正能下单的套餐，名字和封面用代理在店铺装修里改过的。 */
async function agentCatalog(req: Request, agentId: number) {
  const [plans, storefront, salesGate, channels, maxQuantity, base] = await Promise.all([
    loadAgentSellablePlans(agentId),
    db.query.agentStorefronts.findFirst({ where: eq(agentStorefronts.agentId, agentId) }),
    getStoreSalesGate(),
    enabledPaymentChannels(),
    getMaxOrderQuantity(),
    getPublicBaseUrl(req),
  ]);
  const names = rowToSettings(storefront).productNames;
  // 店铺页按组取封面：同组各地区共用基础套餐那一行的图。
  const coverByKey = new Map(plans.map((plan) => [plan.planKey, plan.coverUrl]));
  return {
    store: {
      open: salesGate.open,
      closed_reason: salesGate.publicReason,
      max_quantity: maxQuantity,
      payment_channels: channels,
    },
    plans: plans.map((plan) => {
      const baseKey = plan.basePlanKey || plan.planKey;
      const name = resolveProductName(baseKey, plan.name, names);
      const cover = resolvePlanCover(
        coverByKey.get(baseKey) || plan.coverUrl,
        plan.name,
        plan.planKey,
        plan.basePlanKey,
      );
      return {
        ...regionFields(plan, name.zh),
        name_en: name.en,
        cover_url: absoluteUrl(base, cover),
        kind: plan.localAccount ? "account" : "cdk",
        available: plan.available,
        stock: plan.stock,
        region_confirmation_required: plan.regionConfirmationRequired,
        cost_cents: plan.costCents,
        retail_price_cents: plan.retailPriceCents,
        currency: "CNY",
      };
    }),
  };
}

/** 平台 Key：看全部启用的套餐和全局成本价，不涉及具体店铺。 */
async function platformCatalog() {
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      basePlanKey: platformPlans.basePlanKey,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
      regionNote: platformPlans.regionNote,
      name: platformPlans.name,
      description: platformPlans.description,
      category: platformPlans.category,
      costCents: platformPlans.globalCostPriceCents,
    })
    .from(platformPlans)
    .where(eq(platformPlans.enabled, true))
    .orderBy(asc(platformPlans.sortOrder));
  return {
    plans: rows.map((row) => ({
      ...regionFields(row, row.name),
      cost_cents: row.costCents,
      currency: "CNY",
    })),
  };
}

function catalogFor(req: Request, auth: ApiKeyContext) {
  if (auth.ownerType === "agent" && auth.agentId) return agentCatalog(req, auth.agentId);
  return platformCatalog();
}

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "plans:read");
  if (!isApiKeyContext(auth)) return auth;
  return openOk(await catalogFor(req, auth));
}
