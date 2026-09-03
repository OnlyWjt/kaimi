import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agentSettlements,
  storeOrders,
} from "@/db/schema";
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

export type BlockingSettlement = {
  id: number;
  settlementNo: string;
  amountCents: number;
};

export type RecalculateFeesResult = {
  scanned: number;
  updated: number;
  unchanged: number;
  skippedGatewayActual: number;
  skippedPaidSettlement: number;
  skippedNegative: number;
  skippedNoChannelRule: number;
  releasedSettlements: number;
  /** 待返佣结算单占用着待改收益，撤销后才能重算。 */
  blockingSettlements: BlockingSettlement[];
};

type PlannedChange = {
  orderId: number;
  earningId: number | null;
  feeRatePpm: number;
  fixedFeeCents: number;
  feeCents: number;
  earningCents: number;
  feeSource: string;
};

async function cancelSettlements(ids: number[]) {
  if (!ids.length) return;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(agentSettlements)
      .set({ status: "cancelled" })
      .where(
        and(
          inArray(agentSettlements.id, ids),
          eq(agentSettlements.status, "pending_payment"),
        ),
      );
    await tx
      .update(agentEarnings)
      .set({ settlementId: null, status: "pending", updatedAt: now })
      .where(
        and(
          inArray(agentEarnings.settlementId, ids),
          eq(agentEarnings.status, "settling"),
        ),
      );
    await tx
      .update(agentEarningAdjustments)
      .set({ settlementId: null, status: "pending", updatedAt: now })
      .where(
        and(
          inArray(agentEarningAdjustments.settlementId, ids),
          eq(agentEarningAdjustments.status, "settling"),
        ),
      );
  });
}

export async function recalculateEstimatedFees(
  options: { orderIds?: number[]; releaseSettlements?: boolean } = {},
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
    skippedPaidSettlement: 0,
    skippedNegative: 0,
    skippedNoChannelRule: 0,
    releasedSettlements: 0,
    blockingSettlements: [],
  };

  const ready: PlannedChange[] = [];
  const blocked: PlannedChange[] = [];
  const blockingById = new Map<number, BlockingSettlement>();

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

    const change: PlannedChange = {
      orderId: order.id,
      earningId: null,
      feeRatePpm: rule.feeRatePpm,
      fixedFeeCents: rule.fixedFeeCents,
      feeCents,
      earningCents,
      feeSource:
        order.feeReconcileStatus === "unsupported"
          ? "configured_fallback"
          : "estimated",
    };

    const earningRow = await db.query.agentEarnings.findFirst({
      where: eq(agentEarnings.orderId, order.id),
    });
    if (!earningRow) {
      ready.push(change);
      continue;
    }
    change.earningId = earningRow.id;
    if (earningRow.settlementId === null && earningRow.status === "pending") {
      ready.push(change);
      continue;
    }

    const settlement = earningRow.settlementId
      ? await db.query.agentSettlements.findFirst({
          where: eq(agentSettlements.id, earningRow.settlementId),
        })
      : null;
    // 已返佣的钱不能事后改账；还没返佣的只是被占用，撤销单据就能放出来。
    if (!settlement || settlement.status !== "pending_payment") {
      result.skippedPaidSettlement += 1;
      continue;
    }
    blockingById.set(settlement.id, {
      id: settlement.id,
      settlementNo: settlement.settlementNo,
      amountCents: settlement.amountCents,
    });
    blocked.push(change);
  }

  const applying = [...ready];
  if (options.releaseSettlements && blockingById.size > 0) {
    await cancelSettlements([...blockingById.keys()]);
    result.releasedSettlements = blockingById.size;
    applying.push(...blocked);
  } else {
    result.blockingSettlements = [...blockingById.values()];
  }

  for (const change of applying) {
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(storeOrders)
        .set({
          feeRatePpm: change.feeRatePpm,
          fixedFeeCents: change.fixedFeeCents,
          estimatedPaymentFeeCents: change.feeCents,
          finalPaymentFeeCents: change.feeCents,
          agentEarningCents: change.earningCents,
          updatedAt: now,
        })
        .where(eq(storeOrders.id, change.orderId));
      if (change.earningId !== null) {
        await tx
          .update(agentEarnings)
          .set({
            paymentFeeCents: change.feeCents,
            feeSource: change.feeSource,
            earningCents: change.earningCents,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentEarnings.id, change.earningId),
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
