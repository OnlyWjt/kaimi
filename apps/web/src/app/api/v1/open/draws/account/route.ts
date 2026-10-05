import { getAgentDrawState } from "@/lib/agent-draw";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { agentDrawAccessStatus } from "@/lib/open-api/draw-access";
import { openFail, openOk } from "@/lib/open-api/respond";

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "draw:read");
  if (!isApiKeyContext(auth)) return auth;
  if (auth.ownerType !== "agent" || !auth.agentId) {
    return openFail("FORBIDDEN_SCOPE", "只有代理 Key 可以查提卡额度");
  }
  const status = await agentDrawAccessStatus(auth.agentId);
  if (status !== "approved" && status !== "suspended") {
    return openFail("FORBIDDEN_SCOPE", "还没有提卡权限");
  }
  const state = await getAgentDrawState(auth.agentId);
  if (!state.credit || !state.limits || !state.summary || !state.lifetime || !state.plans) {
    return openFail("FORBIDDEN_SCOPE", "还没有提卡权限");
  }
  const { credit, limits, summary, lifetime, plans } = state;
  return openOk({
    status: state.status,
    can_draw: state.canDraw,
    credit: {
      limit_cents: credit.limitCents,
      unsettled_cents: credit.unsettledCents,
      inflight_cents: credit.inflightCents,
      exposure_cents: credit.exposureCents,
      available_cents: credit.availableCents,
    },
    limits: {
      max_per_draw: limits.maxPerDraw,
      daily_limit: limits.dailyLimit,
      today_count: limits.todayCount,
    },
    unsettled: {
      count: summary.count,
      amount_cents: summary.amountCents,
      plans: summary.groups.map((group) => ({
        plan_key: group.planKey,
        plan_name: group.planName,
        unit_price_cents: group.unitPriceCents,
        count: group.count,
        amount_cents: group.amountCents,
      })),
    },
    lifetime: {
      count: lifetime.count,
      amount_cents: lifetime.amountCents,
      settled_count: lifetime.settledCount,
      settled_cents: lifetime.settledCents,
    },
    plans: plans.map((plan) => ({
      plan_key: plan.planKey,
      name: plan.name,
      unit_price_cents: plan.unitPriceCents,
    })),
  });
}
