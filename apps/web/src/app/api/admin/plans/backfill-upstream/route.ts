import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { platformPlans, storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { computeOrderLedger, ledgerInputFromOrder } from "@/lib/order-ledger-core";

export async function POST() {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const plans = await db.query.platformPlans.findMany();
  const unitByPlan = new Map(
    plans
      .filter((plan) => plan.upstreamCostCents != null)
      .map((plan) => [plan.id, plan.upstreamCostCents as number]),
  );
  const orders = await db.query.storeOrders.findMany({
    where: and(eq(storeOrders.payStatus, "paid"), eq(storeOrders.upstreamCostSource, "unset")),
  });
  let updated = 0;
  for (const order of orders) {
    const unit = unitByPlan.get(order.planId);
    if (unit == null) continue;
    const quantity = Math.max(1, order.quantity);
    const total = unit * quantity;
    const ledger = computeOrderLedger(
      ledgerInputFromOrder({ ...order, upstreamCostTotalCents: total }),
      { gatewayFeeCents: order.finalPaymentFeeCents },
    );
    const [written] = await db
      .update(storeOrders)
      .set({
        upstreamCostUnitCents: unit,
        upstreamCostTotalCents: total,
        upstreamCostSource: "backfill",
        platformProfitCents: ledger.platformProfitCents,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(storeOrders.id, order.id), isNull(storeOrders.upstreamCostTotalCents)))
      .returning({ id: storeOrders.id });
    if (written) updated += 1;
  }
  await writeAuditLog({
    actor: session,
    action: "admin.plan.backfill_upstream",
    targetType: "platform_plan",
    metadata: { updated },
  });
  return NextResponse.json({ ok: true, updated });
}
