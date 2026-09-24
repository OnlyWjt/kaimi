import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, storeOrders } from "@/db/schema";
import { decryptSecret, maskCode } from "@/lib/crypto";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openFail, openOk } from "@/lib/open-api/respond";

export async function GET(
  req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  const auth = await requireApiKey(req, "orders:read");
  if (!isApiKeyContext(auth)) return auth;
  const { orderNo } = await context.params;
  const filters = [eq(storeOrders.orderNo, orderNo)];
  if (auth.ownerType === "agent" && auth.agentId) {
    filters.push(eq(storeOrders.agentId, auth.agentId));
  }
  const order = await db.query.storeOrders.findFirst({
    where: and(...filters),
  });
  if (!order) return openFail("NOT_FOUND", "订单不存在");
  const cdks = await db
    .select({
      id: issuedCdks.id,
      status: issuedCdks.status,
      planKey: issuedCdks.planKey,
      codeEncrypted: issuedCdks.codeEncrypted,
      issuedAt: issuedCdks.issuedAt,
      usedAt: issuedCdks.usedAt,
    })
    .from(issuedCdks)
    .where(eq(issuedCdks.orderId, order.id));
  return openOk({
    order_no: order.orderNo,
    plan_key: order.planKeySnapshot,
    product_name: order.productNameSnapshot,
    quantity: order.quantity,
    gross_cents: order.grossCents,
    currency: order.currency,
    customer_email: order.customerEmail,
    pay_status: order.payStatus,
    fulfill_status: order.fulfillStatus,
    created_at: order.createdAt,
    paid_at: order.paidAt,
    cdks: cdks.map((cdk) => {
      let masked = "";
      try {
        masked = maskCode(decryptSecret(cdk.codeEncrypted));
      } catch {
        masked = "";
      }
      return {
        id: cdk.id,
        status: cdk.status,
        plan_key: cdk.planKey,
        code_masked: masked,
        issued_at: cdk.issuedAt,
        used_at: cdk.usedAt,
      };
    }),
  });
}
