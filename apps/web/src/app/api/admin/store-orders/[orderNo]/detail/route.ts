import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, issuedCdks, orders, storeOrders, users } from "@/db/schema";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret, maskCode } from "@/lib/crypto";
import { FINISHED_GPT_PLAN_KEY } from "@/lib/finished-account-core";

function deliveryPreview(code: string, finished: boolean) {
  if (!code) return "";
  if (finished) return code.split("----")[0] || maskCode(code);
  return maskCode(code);
}

export async function GET(_req: Request, context: { params: Promise<{ orderNo: string }> }) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const { orderNo } = await context.params;
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  const agent = await db
    .select({
      id: agents.id,
      displayName: agents.displayName,
      shopName: agents.shopName,
      realName: agents.realName,
      settlementName: agents.settlementName,
      username: users.username,
    })
    .from(agents)
    .leftJoin(users, eq(users.agentId, agents.id))
    .where(eq(agents.id, order.agentId))
    .then((rows) => rows[0]);
  const issued = await db.select().from(issuedCdks).where(eq(issuedCdks.orderId, order.id));
  const finished = order.planKeySnapshot === FINISHED_GPT_PLAN_KEY;
  const redemptions = await db
    .select({
      orderNo: orders.orderNo,
      fulfillStatus: orders.fulfillStatus,
      email: orders.email,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.storeOrderId, order.id));
  return NextResponse.json({
    orderNo: order.orderNo,
    agent: agent ? agentIdentityLabel(agent) : "",
    email: order.customerEmail,
    plan: order.productNameSnapshot,
    quantity: order.quantity,
    grossCents: order.grossCents,
    payStatus: order.payStatus,
    fulfillStatus: order.fulfillStatus,
    channel: order.paymentChannel,
    productKind: finished ? "finished" : "cdk",
    createdAt: order.createdAt,
    message: order.lastErrorMessage || "",
    items: issued.map((row) => {
      let plain = "";
      try {
        plain = decryptSecret(row.codeEncrypted);
      } catch {
        plain = "";
      }
      return {
        id: row.id,
        preview: deliveryPreview(plain, finished),
      };
    }),
    redemptions,
  });
}
