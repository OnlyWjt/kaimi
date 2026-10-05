import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentDrawOrders } from "@/db/schema";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { agentDrawAccessStatus } from "@/lib/open-api/draw-access";
import { openFail, openOk } from "@/lib/open-api/respond";

export async function GET(req: Request, context: { params: Promise<{ drawNo: string }> }) {
  const auth = await requireApiKey(req, "draw:read");
  if (!isApiKeyContext(auth)) return auth;
  if (auth.ownerType !== "agent" || !auth.agentId) {
    return openFail("FORBIDDEN_SCOPE", "只有代理 Key 可以查提卡");
  }
  const status = await agentDrawAccessStatus(auth.agentId);
  if (status !== "approved" && status !== "suspended") {
    return openFail("FORBIDDEN_SCOPE", "还没有提卡权限");
  }
  const { drawNo } = await context.params;
  const order = await db.query.agentDrawOrders.findFirst({
    where: and(eq(agentDrawOrders.agentId, auth.agentId), eq(agentDrawOrders.drawNo, drawNo)),
  });
  if (!order) return openFail("NOT_FOUND", "提卡单不存在");
  return openOk({
    draw_no: order.drawNo,
    status: order.status,
    plan_name: order.planNameSnapshot,
    quantity: order.quantity,
    issued_count: order.issuedCount,
    unit_price_cents: order.unitPriceCents,
    amount_cents: order.unitPriceCents * order.issuedCount,
    created_at: order.createdAt,
    message: order.lastErrorMessage || "",
  });
}
