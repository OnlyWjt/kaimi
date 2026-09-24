import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { getOrderTimeline } from "@/lib/order-timeline";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openFail, openOk } from "@/lib/open-api/respond";

export async function GET(
  req: Request,
  context: { params: Promise<{ no: string }> },
) {
  const auth = await requireApiKey(req, "redeem:read");
  if (!isApiKeyContext(auth)) return auth;
  const { no } = await context.params;
  const filters = [eq(orders.orderNo, no), eq(orders.kind, "recharge")];
  if (auth.ownerType === "agent" && auth.agentId) {
    filters.push(eq(orders.agentId, auth.agentId));
  }
  const order = await db.query.orders.findFirst({ where: and(...filters) });
  if (!order) return openFail("NOT_FOUND", "兑换单不存在");
  const timeline = await getOrderTimeline(order.id);
  return openOk({
    redemption_no: order.orderNo,
    status: order.fulfillStatus,
    message: order.message,
    plan_key: order.upstreamPlan,
    email: order.accountEmail || order.email,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    timeline: timeline.map((item) => ({
      step: item.step,
      category: item.category,
      message: item.message,
      at: item.at,
    })),
  });
}
