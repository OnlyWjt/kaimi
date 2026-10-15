import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentDrawItems,
  agentDrawOrders,
  agentEarningAdjustments,
  agentEarnings,
  agentReconciliationClaims,
  agentSettlements,
  storeOrders,
} from "@/db/schema";
import type { AuthSession } from "@/lib/auth";
import { verifyLedger } from "@/lib/order-ledger-core";
import {
  adjustmentFingerprint,
  directionOf,
  drawItemFingerprint,
  earningFingerprint,
  snapshotHash,
  splitLocked,
  totalsOf,
  type ReconciliationDirection,
  type ReconciliationSourceType,
  type SnapshotLine,
} from "@/lib/reconciliation-core";

// 对账的底层：错误类型，以及把代理名下的商店收益、调整、提卡收集成待结行。

export class ReconciliationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Actor = Pick<AuthSession, "id" | "role">;

export type Line = SnapshotLine & {
  bucket: "open" | "locked" | "skipped";
  /** locked 行：占用它的 active claim 所在批次。没有则是旧周结单占用。 */
  claimBatchId?: number | null;
  /** locked 且无 claim：旧周结单号（settlementId 为空时没有）。 */
  legacySettlementNo?: string | null;
  orderNo: string;
  occurredAt: string;
  skipCode?: string;
  skipMessage?: string;
  snapshot: Record<string, unknown>;
  amountKnown: boolean;
};

export function skipMessage(code: string) {
  if (code === "MANUAL_REVIEW_REQUIRED") return "核对渠道凭证后重算";
  if (code === "LEDGER_MISMATCH") return "订单和收益行对不上，先按快照核对";
  return "缺收益行或来源数据，先补齐再纳入";
}

export function snapText(snapshot: Record<string, unknown>, key: string) {
  return typeof snapshot[key] === "string" ? snapshot[key] : "";
}

export function snapCents(snapshot: Record<string, unknown>, key: string) {
  return typeof snapshot[key] === "number" ? snapshot[key] : null;
}

/** 给对账表用的展示字段。不参与快照哈希。 */
export function lineFace(line: Pick<Line, "occurredAt" | "snapshot">) {
  const snapshot = line.snapshot;
  return {
    occurredAt: line.occurredAt,
    title: snapText(snapshot, "productName") || snapText(snapshot, "planName") || snapText(snapshot, "reason") || snapText(snapshot, "type"),
    goodsCents: snapCents(snapshot, "goodsCents"),
    feeCents: snapCents(snapshot, "agentFeeCents"),
  };
}

export function lineDirection(type: ReconciliationSourceType, amount: number): ReconciliationDirection {
  if (type === "draw_item") return "agent_pays_platform";
  return directionOf(amount);
}

export async function loadLines(tx: Tx | typeof db, agentId: number, cutoffAt: string): Promise<Line[]> {
  const tagged = await collectLines(tx, agentId, cutoffAt);
  return tagged.map((row) => row.line);
}

/** agentId 为空时一次捞出全部代理的未结行，名单接口不用按人循环查。 */
export async function collectLines(tx: Tx | typeof db, agentId: number | null, cutoffAt: string) {
  const earnings = await tx
    .select({
      agentId: agentEarnings.agentId,
      earningId: agentEarnings.id,
      earningCents: agentEarnings.earningCents,
      earningStatus: agentEarnings.status,
      earningSettlementId: agentEarnings.settlementId,
      confirmedAt: agentEarnings.confirmedAt,
      rowGross: agentEarnings.grossCents,
      rowCost: agentEarnings.costCents,
      rowFee: agentEarnings.agentFeeCents,
      orderId: storeOrders.id,
      orderNo: storeOrders.orderNo,
      productName: storeOrders.productNameSnapshot,
      grossCents: storeOrders.grossCents,
      listGoodsCents: storeOrders.listGoodsCents,
      couponDiscountCents: storeOrders.couponDiscountCents,
      invoiceSurchargeCents: storeOrders.invoiceSurchargeCents,
      agentCostTotalCents: storeOrders.agentCostTotalCents,
      upstreamCostTotalCents: storeOrders.upstreamCostTotalCents,
      feeRatePpm: storeOrders.feeRatePpm,
      fixedFeeCents: storeOrders.fixedFeeCents,
      finalPaymentFeeCents: storeOrders.finalPaymentFeeCents,
      agentFeeCents: storeOrders.agentFeeCents,
      platformFeeCents: storeOrders.platformFeeCents,
      orderEarningCents: storeOrders.agentEarningCents,
      platformProfitCents: storeOrders.platformProfitCents,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .where(
      and(
        ...(agentId == null ? [] : [eq(agentEarnings.agentId, agentId)]),
        inArray(agentEarnings.status, ["pending", "settling"]),
        lte(agentEarnings.confirmedAt, cutoffAt),
        eq(storeOrders.payStatus, "paid"),
        eq(storeOrders.fulfillStatus, "delivered"),
      ),
    );

  const missing = await tx
    .select({
      agentId: storeOrders.agentId,
      orderNo: storeOrders.orderNo,
      occurredAt: storeOrders.deliveredAt,
      paidAt: storeOrders.paidAt,
    })
    .from(storeOrders)
    .leftJoin(agentEarnings, eq(agentEarnings.orderId, storeOrders.id))
    .where(
      and(
        ...(agentId == null ? [] : [eq(storeOrders.agentId, agentId)]),
        eq(storeOrders.payStatus, "paid"),
        eq(storeOrders.fulfillStatus, "delivered"),
        sql`${agentEarnings.id} is null`,
        sql`coalesce(${storeOrders.deliveredAt}, ${storeOrders.paidAt}, ${storeOrders.createdAt}) <= ${cutoffAt}`,
      ),
    );

  const adjustments = await tx
    .select()
    .from(agentEarningAdjustments)
    .where(
      and(
        ...(agentId == null ? [] : [eq(agentEarningAdjustments.agentId, agentId)]),
        inArray(agentEarningAdjustments.status, ["pending", "settling"]),
        lte(agentEarningAdjustments.createdAt, cutoffAt),
        sql`EXISTS (
          SELECT 1 FROM store_orders
          WHERE store_orders.id = ${agentEarningAdjustments.orderId}
            AND store_orders.pay_status != 'refunding'
        )`,
      ),
    );

  const draws = await tx
    .select({
      agentId: agentDrawItems.agentId,
      id: agentDrawItems.id,
      amountCents: agentDrawItems.amountCents,
      drawOrderId: agentDrawItems.drawOrderId,
      createdAt: agentDrawItems.createdAt,
      planKey: agentDrawItems.planKey,
      drawNo: agentDrawOrders.drawNo,
      planName: agentDrawOrders.planNameSnapshot,
    })
    .from(agentDrawItems)
    .innerJoin(agentDrawOrders, eq(agentDrawOrders.id, agentDrawItems.drawOrderId))
    .where(
      and(
        ...(agentId == null ? [] : [eq(agentDrawItems.agentId, agentId)]),
        eq(agentDrawItems.status, "unsettled"),
        lte(agentDrawItems.createdAt, cutoffAt),
      ),
    );

  const claims = await tx
    .select({
      sourceType: agentReconciliationClaims.sourceType,
      sourceId: agentReconciliationClaims.sourceId,
      batchId: agentReconciliationClaims.batchId,
    })
    .from(agentReconciliationClaims)
    .where(eq(agentReconciliationClaims.claimState, "active"));
  const claimed = new Map(claims.map((row) => [`${row.sourceType}:${row.sourceId}`, row.batchId]));

  // 旧周结单号：只给 settling 且没有 claim 的收益/调整查，用 settlementId 关联。
  const legacyIds = new Set<number>();
  for (const row of earnings) {
    if (row.earningStatus === "settling" && !claimed.has(`earning:${row.earningId}`) && row.earningSettlementId) {
      legacyIds.add(row.earningSettlementId);
    }
  }
  for (const row of adjustments) {
    if (row.status === "settling" && !claimed.has(`adjustment:${row.id}`) && row.settlementId) {
      legacyIds.add(row.settlementId);
    }
  }
  const legacyNos = new Map<number, string>();
  if (legacyIds.size) {
    const found = await tx
      .select({ id: agentSettlements.id, settlementNo: agentSettlements.settlementNo })
      .from(agentSettlements)
      .where(inArray(agentSettlements.id, [...legacyIds]));
    for (const row of found) legacyNos.set(row.id, row.settlementNo);
  }

  const tagged: Array<{ agentId: number; line: Line }> = [];
  for (const row of earnings) {
    const goods = row.grossCents - row.invoiceSurchargeCents;
    const snapshot = {
      productName: row.productName,
      occurredAt: row.confirmedAt,
      orderNo: row.orderNo,
      listGoodsCents: row.listGoodsCents,
      couponDiscountCents: row.couponDiscountCents,
      goodsCents: goods,
      agentCostCents: row.agentCostTotalCents,
      agentFeeCents: row.agentFeeCents,
      platformFeeCents: row.platformFeeCents,
      channelFeeCents: row.finalPaymentFeeCents,
      invoiceSurchargeCents: row.invoiceSurchargeCents,
      upstreamCostCents: row.upstreamCostTotalCents,
      earningCents: row.earningCents,
      orderId: row.orderId,
    };
    const base = {
      sourceType: "earning" as const,
      sourceId: row.earningId,
      sourceVersion: earningFingerprint({
        earningCents: row.earningCents,
        grossCents: row.rowGross,
        costCents: row.rowCost,
        agentFeeCents: row.rowFee,
        orderId: row.orderId,
      }),
      amountCents: row.earningCents,
      orderNo: row.orderNo,
      occurredAt: row.confirmedAt,
      snapshot,
      amountKnown: true,
    };
    if (row.earningStatus === "settling" || claimed.has(`earning:${row.earningId}`)) {
      tagged.push({ agentId: row.agentId, line: {
        ...base,
        bucket: "locked",
        claimBatchId: claimed.get(`earning:${row.earningId}`) ?? null,
        legacySettlementNo: row.earningSettlementId ? legacyNos.get(row.earningSettlementId) ?? null : null,
      } });
      continue;
    }
    if (row.feeReconcileStatus === "manual_review") {
      tagged.push({ agentId: row.agentId, line: {
        ...base,
        bucket: "skipped",
        skipCode: "MANUAL_REVIEW_REQUIRED",
        skipMessage: skipMessage("MANUAL_REVIEW_REQUIRED"),
      } });
      continue;
    }
    const issues = verifyLedger(
      {
        grossCents: row.grossCents,
        invoiceSurchargeCents: row.invoiceSurchargeCents,
        agentCostTotalCents: row.agentCostTotalCents,
        upstreamCostTotalCents: row.upstreamCostTotalCents,
        feeRatePpm: row.feeRatePpm,
        fixedFeeCents: row.fixedFeeCents,
        finalPaymentFeeCents: row.finalPaymentFeeCents,
        agentFeeCents: row.agentFeeCents,
        platformFeeCents: row.platformFeeCents,
        agentEarningCents: row.orderEarningCents,
        platformProfitCents: row.platformProfitCents,
      },
      {
        grossCents: row.rowGross,
        costCents: row.rowCost,
        agentFeeCents: row.rowFee,
        earningCents: row.earningCents,
      },
    );
    if (issues.length) {
      tagged.push({ agentId: row.agentId, line: {
        ...base,
        bucket: "skipped",
        skipCode: "LEDGER_MISMATCH",
        skipMessage: skipMessage("LEDGER_MISMATCH"),
      } });
      continue;
    }
    tagged.push({ agentId: row.agentId, line: { ...base, bucket: "open" } });
  }
  for (const row of missing) {
    if (!row.agentId) continue;
    tagged.push({ agentId: row.agentId, line: {
      sourceType: "earning",
      sourceId: 0,
      sourceVersion: "",
      amountCents: 0,
      bucket: "skipped",
      orderNo: row.orderNo,
      occurredAt: row.occurredAt || row.paidAt || cutoffAt,
      skipCode: "MISSING_SOURCE",
      skipMessage: skipMessage("MISSING_SOURCE"),
      snapshot: { orderNo: row.orderNo },
      amountKnown: false,
    } });
  }
  for (const row of adjustments) {
    const base = {
      sourceType: "adjustment" as const,
      sourceId: row.id,
      sourceVersion: adjustmentFingerprint(row),
      amountCents: row.amountCents,
      orderNo: row.reference || String(row.orderId),
      occurredAt: row.createdAt,
      snapshot: {
        orderId: row.orderId,
        sourceEarningId: row.sourceEarningId,
        type: row.type,
        sequence: row.sequence,
        reason: row.reason,
        originalBatchId: row.originalBatchId,
        amountCents: row.amountCents,
        occurredAt: row.createdAt,
      },
      amountKnown: true,
    };
    const locked = row.status === "settling" || claimed.has(`adjustment:${row.id}`);
    tagged.push({ agentId: row.agentId, line: {
      ...base,
      bucket: locked ? "locked" : "open",
      ...(locked
        ? {
            claimBatchId: claimed.get(`adjustment:${row.id}`) ?? null,
            legacySettlementNo: row.settlementId ? legacyNos.get(row.settlementId) ?? null : null,
          }
        : {}),
    } });
  }
  for (const row of draws) {
    const base = {
      sourceType: "draw_item" as const,
      sourceId: row.id,
      sourceVersion: drawItemFingerprint(row),
      amountCents: row.amountCents,
      orderNo: row.drawNo,
      occurredAt: row.createdAt,
      snapshot: {
        drawNo: row.drawNo,
        planKey: row.planKey,
        planName: row.planName,
        occurredAt: row.createdAt,
        amountCents: row.amountCents,
      },
      amountKnown: true,
    };
    tagged.push({ agentId: row.agentId, line: {
      ...base,
      bucket: claimed.has(`draw_item:${row.id}`) ? "locked" : "open",
      claimBatchId: claimed.get(`draw_item:${row.id}`) ?? null,
    } });
  }
  return tagged;
}

export function partition(lines: Line[]) {
  const open = lines.filter((line) => line.bucket === "open");
  const locked = lines.filter((line) => line.bucket === "locked");
  const skipped = lines.filter((line) => line.bucket === "skipped");
  const sum = (rows: Line[], knownOnly = true) =>
    rows.reduce((total, row) => total + (knownOnly && !row.amountKnown ? 0 : row.amountCents), 0);
  return {
    open,
    locked,
    skipped,
    openTotals: totalsOf(open),
    lockedTotals: totalsOf(locked),
    ...splitLocked(locked),
    skippedKnownCents: sum(skipped),
    skippedUnknownCount: skipped.filter((row) => !row.amountKnown).length,
    previewVersion: snapshotHash(open),
  };
}
