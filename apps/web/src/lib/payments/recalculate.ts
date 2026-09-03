import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentEarnings, storeOrders } from "@/db/schema";
import { calculateAgentEarningCents, calculatePaymentFeeCents } from "./fees";

/**
 * 手续费是下单那一刻按当时费率算好写进订单的，之后不会自己变。
 * 费率填错过就得按现在的配置重算一遍，否则代理看到的收益和结算单都会一直沿用错的数。
 * 只重算「估算来的」手续费；网关回过真实金额（confirmed）的不动。
 */
const RECALCULABLE_FEE_STATUSES = [
  "pending",
  "retrying",
  "manual_review",
  "unsupported",
];

export type RecalculateFeesResult = {
  scanned: number;
  updated: number;
  unchanged: number;
  skippedGatewayActual: number;
  skippedSettled: number;
  skippedNegative: number;
  skippedNoChannelRule: number;
};

export async function recalculateEstimatedFees(
  options: { orderIds?: number[] } = {},
) {
  const rules = await db.query.paymentChannelConfigs.findMany();
  const ruleByChannel = new Map(rules.map((row) => [row.channel, row]));

  const conditions = [
    eq(storeOrders.payStatus, "paid"),
    inArray(storeOrders.feeReconcileStatus, RECALCULABLE_FEE_STATUSES),
  ];
  if (options.orderIds?.length) {
    conditions.push(inArray(storeOrders.id, options.orderIds));
  }
  const orders = await db.query.storeOrders.findMany({
    where: and(...conditions),
  });

  const [confirmed] = await db
    .select({ total: sql<number>`count(*)` })
    .from(storeOrders)
    .where(
      and(
        eq(storeOrders.payStatus, "paid"),
        eq(storeOrders.feeReconcileStatus, "confirmed"),
      ),
    );

  const result: RecalculateFeesResult = {
    scanned: orders.length,
    updated: 0,
    unchanged: 0,
    skippedGatewayActual: Number(confirmed?.total || 0),
    skippedSettled: 0,
    skippedNegative: 0,
    skippedNoChannelRule: 0,
  };

  for (const order of orders) {
    const rule = ruleByChannel.get(order.paymentChannel);
    if (!rule) {
      result.skippedNoChannelRule += 1;
      continue;
    }

    const feeCents = calculatePaymentFeeCents(order.retailPriceCents, {
      ratePpm: rule.feeRatePpm,
      fixedFeeCents: rule.fixedFeeCents,
    });
    const earningCents = calculateAgentEarningCents(
      order.retailPriceCents,
      order.agentCostCents,
      feeCents,
    );
    // 费率高到把毛利吃穿了，宁可报出来让人改配置，也不写一个负收益进结算。
    if (earningCents < 0) {
      result.skippedNegative += 1;
      continue;
    }
    if (
      feeCents === order.estimatedPaymentFeeCents &&
      feeCents === order.finalPaymentFeeCents &&
      earningCents === order.agentEarningCents &&
      rule.feeRatePpm === order.feeRatePpm &&
      rule.fixedFeeCents === order.fixedFeeCents
    ) {
      result.unchanged += 1;
      continue;
    }

    const earningRow = await db.query.agentEarnings.findFirst({
      where: eq(agentEarnings.orderId, order.id),
    });
    // 已经进过结算单的收益不能改，那笔钱已经按当时的金额算给代理了。
    if (
      earningRow &&
      (earningRow.settlementId !== null || earningRow.status !== "pending")
    ) {
      result.skippedSettled += 1;
      continue;
    }

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(storeOrders)
        .set({
          feeRatePpm: rule.feeRatePpm,
          fixedFeeCents: rule.fixedFeeCents,
          estimatedPaymentFeeCents: feeCents,
          finalPaymentFeeCents: feeCents,
          agentEarningCents: earningCents,
          updatedAt: now,
        })
        .where(eq(storeOrders.id, order.id));
      if (earningRow) {
        await tx
          .update(agentEarnings)
          .set({
            paymentFeeCents: feeCents,
            feeSource:
              order.feeReconcileStatus === "unsupported"
                ? "configured_fallback"
                : "estimated",
            earningCents,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentEarnings.id, earningRow.id),
              eq(agentEarnings.status, "pending"),
              isNull(agentEarnings.settlementId),
            ),
          );
      }
    });
    result.updated += 1;
  }

  return result;
}
