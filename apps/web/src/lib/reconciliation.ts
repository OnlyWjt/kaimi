import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentDrawItems,
  agentDrawOrders,
  agentEarningAdjustments,
  agentEarnings,
  agentReconciliationBatches,
  agentReconciliationClaims,
  agentReconciliationCorrections,
  agentReconciliationItems,
  agentSettlements,
  agents,
  auditLogs,
  reconciliationIdempotency,
  storeOrders,
} from "@/db/schema";
import type { AuthSession } from "@/lib/auth";
import { newOrderNo } from "@/lib/ids";
import { verifyLedger } from "@/lib/order-ledger-core";
import {
  adjustmentFingerprint,
  adjustmentTypeForCorrection,
  assertCorrectionSequence,
  checkAdjustmentFloor,
  checkCorrectionAmount,
  cutoffInFuture,
  directionLabel,
  directionOf,
  drawItemFingerprint,
  earningFingerprint,
  isFingerprintVersion,
  isIsoUtc,
  netCents,
  payloadHash,
  snapshotHash,
  splitLocked,
  totalsOf,
  checkNoRevive,
  validateClear,
  validateMarkPaid,
  type CorrectionApiType,
  type ReconciliationDirection,
  type ReconciliationSourceType,
  type SnapshotLine,
} from "@/lib/reconciliation-core";

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = Pick<AuthSession, "id" | "role">;

type Line = SnapshotLine & {
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

const PAYMENT_FIELDS = ["paymentMethod", "paymentReference", "actualPaymentAt", "note", "amountCents", "currency"] as const;

function skipMessage(code: string) {
  if (code === "MANUAL_REVIEW_REQUIRED") return "核对渠道凭证后重算";
  if (code === "LEDGER_MISMATCH") return "订单和收益行对不上，先按快照核对";
  return "缺收益行或来源数据，先补齐再纳入";
}

function snapText(snapshot: Record<string, unknown>, key: string) {
  return typeof snapshot[key] === "string" ? snapshot[key] : "";
}

function snapCents(snapshot: Record<string, unknown>, key: string) {
  return typeof snapshot[key] === "number" ? snapshot[key] : null;
}

/** 给对账表用的展示字段。不参与快照哈希。 */
function lineFace(line: Pick<Line, "occurredAt" | "snapshot">) {
  const snapshot = line.snapshot;
  return {
    occurredAt: line.occurredAt,
    title: snapText(snapshot, "productName") || snapText(snapshot, "planName") || snapText(snapshot, "reason") || snapText(snapshot, "type"),
    goodsCents: snapCents(snapshot, "goodsCents"),
    feeCents: snapCents(snapshot, "agentFeeCents"),
  };
}

function lineDirection(type: ReconciliationSourceType, amount: number): ReconciliationDirection {
  if (type === "draw_item") return "agent_pays_platform";
  return directionOf(amount);
}

async function loadLines(tx: Tx | typeof db, agentId: number, cutoffAt: string): Promise<Line[]> {
  const tagged = await collectLines(tx, agentId, cutoffAt);
  return tagged.map((row) => row.line);
}

/** agentId 为空时一次捞出全部代理的未结行，名单接口不用按人循环查。 */
async function collectLines(tx: Tx | typeof db, agentId: number | null, cutoffAt: string) {
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

function partition(lines: Line[]) {
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

function sameSelection(
  open: Line[],
  items: Array<{ type: ReconciliationSourceType; id: number; version: string }>,
) {
  const left = open.map((line) => `${line.sourceType}:${line.sourceId}:${line.sourceVersion}`).sort();
  const right = items.map((item) => `${item.type}:${item.id}:${item.version}`).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

async function audit(
  tx: Tx,
  input: {
    actor: Actor;
    ip: string;
    action: string;
    targetId: number;
    before: unknown;
    after: unknown;
    batchId: number;
  },
) {
  await tx.insert(auditLogs).values({
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    action: input.action,
    targetType: "agent_reconciliation_batch",
    targetId: String(input.targetId),
    metadataJson: JSON.stringify({
      before: input.before,
      after: input.after,
      sourceBatchId: input.batchId,
    }),
    ip: input.ip,
  });
}

async function replay(tx: Tx, actorId: number, action: string, key: string, hash: string) {
  const existing = await tx.query.reconciliationIdempotency.findFirst({
    where: and(
      eq(reconciliationIdempotency.actorId, actorId),
      eq(reconciliationIdempotency.action, action),
      eq(reconciliationIdempotency.idempotencyKey, key),
    ),
  });
  if (!existing) return null;
  if (existing.payloadHash !== hash) {
    throw new ReconciliationError("IDEMPOTENCY_CONFLICT", "同一个幂等键不能换成另一笔请求", 409);
  }
  if (!existing.resultJson) {
    throw new ReconciliationError("IDEMPOTENCY_CONFLICT", "上一笔相同请求还在处理，请稍后重试", 409, true);
  }
  return JSON.parse(existing.resultJson) as { status: number; body: unknown };
}

async function holdIdempotency(tx: Tx, actorId: number, action: string, key: string, hash: string) {
  await tx.insert(reconciliationIdempotency).values({
    actorId,
    action,
    idempotencyKey: key,
    payloadHash: hash,
    resultStatus: 0,
    resultJson: "",
  });
}

async function finishIdempotency(
  tx: Tx,
  actorId: number,
  action: string,
  key: string,
  status: number,
  body: unknown,
) {
  await tx
    .update(reconciliationIdempotency)
    .set({ resultStatus: status, resultJson: JSON.stringify({ status, body }) })
    .where(
      and(
        eq(reconciliationIdempotency.actorId, actorId),
        eq(reconciliationIdempotency.action, action),
        eq(reconciliationIdempotency.idempotencyKey, key),
      ),
    );
}

function isIdempotencyRace(error: unknown) {
  return /reconciliation_idempotency/i.test(String(error));
}

async function readFinished(actorId: number, action: string, key: string, hash: string) {
  const existing = await db.query.reconciliationIdempotency.findFirst({
    where: and(
      eq(reconciliationIdempotency.actorId, actorId),
      eq(reconciliationIdempotency.action, action),
      eq(reconciliationIdempotency.idempotencyKey, key),
    ),
  });
  if (!existing) {
    throw new ReconciliationError("IDEMPOTENCY_CONFLICT", "相同请求正在处理，请重试", 409, true);
  }
  if (existing.payloadHash !== hash) {
    throw new ReconciliationError("IDEMPOTENCY_CONFLICT", "同一个幂等键不能换成另一笔请求", 409);
  }
  if (!existing.resultJson) {
    throw new ReconciliationError("IDEMPOTENCY_CONFLICT", "相同请求正在处理，请重试", 409, true);
  }
  return JSON.parse(existing.resultJson) as { status: number; body: unknown };
}

function assertCutoff(cutoffAt: string) {
  if (!isIsoUtc(cutoffAt)) {
    throw new ReconciliationError("INVALID_STATE", "cutoffAt 要用 UTC 时间", 422);
  }
  if (cutoffInFuture(cutoffAt)) {
    throw new ReconciliationError("INVALID_STATE", "截止时间不能晚于现在", 422);
  }
}

export async function previewReconciliation(agentId: number, cutoffAt: string) {
  assertCutoff(cutoffAt);
  const lines = await loadLines(db, agentId, cutoffAt);
  const view = partition(lines);
  return {
    agentId,
    currency: "CNY" as const,
    cutoffAt,
    previewVersion: view.previewVersion,
    totals: {
      storeEarningCents: view.openTotals.storeEarningCents,
      adjustmentCents: view.openTotals.adjustmentCents,
      drawDebtCents: view.openTotals.drawDebtCents,
      netCents: view.openTotals.netCents,
      direction: view.openTotals.direction,
    },
    locked: {
      netCents: view.lockedTotals.netCents,
      storeEarningCents: view.lockedTotals.storeEarningCents,
      adjustmentCents: view.lockedTotals.adjustmentCents,
      drawDebtCents: view.lockedTotals.drawDebtCents,
      itemCount: view.lockedTotals.itemCount,
    },
    lockedInBatch: view.lockedInBatch,
    lockedLegacy: view.lockedLegacy,
    skipped: view.skipped.map((line) => ({
      orderNo: line.orderNo,
      code: line.skipCode,
      message: line.skipMessage,
      amountCents: line.amountKnown ? line.amountCents : null,
    })),
    skippedUnknownCount: view.skippedUnknownCount,
    items: view.open.map((line) => ({
      type: line.sourceType,
      id: line.sourceId,
      version: line.sourceVersion,
      amountCents: line.amountCents,
      orderNo: line.orderNo,
      ...lineFace(line),
    })),
    note: "可对账净额，不含待核对项",
  };
}

export async function createReconciliation(input: {
  actor: Actor;
  ip: string;
  idempotencyKey: string;
  agentId: number;
  cutoffAt: string;
  previewVersion: string;
  items: Array<{ type: ReconciliationSourceType; id: number; version: string }>;
  acknowledgedSkipped: string[];
}) {
  assertCutoff(input.cutoffAt);
  const hash = payloadHash("create", {
    agentId: input.agentId,
    cutoffAt: input.cutoffAt,
    previewVersion: input.previewVersion,
    items: input.items,
    acknowledgedSkipped: input.acknowledgedSkipped,
  });
  try {
    return await db.transaction(async (tx) => {
      const done = await replay(tx, input.actor.id, "create", input.idempotencyKey, hash);
      if (done) return done;
      await holdIdempotency(tx, input.actor.id, "create", input.idempotencyKey, hash);
      const lines = await loadLines(tx, input.agentId, input.cutoffAt);
      const view = partition(lines);
      if (!view.open.length) {
        throw new ReconciliationError("EMPTY_BATCH", "没有可纳入的未结明细", 422);
      }
      if (view.previewVersion !== input.previewVersion || !sameSelection(view.open, input.items)) {
        throw new ReconciliationError("SNAPSHOT_CHANGED", "未结明细变了，请重新预览后再生成", 409);
      }
      const skippedKeys = view.skipped.map((line) => line.orderNo);
      const missingAck = skippedKeys.filter((key) => !input.acknowledgedSkipped.includes(key));
      if (missingAck.length) {
        throw new ReconciliationError(
          view.skipped.find((line) => line.orderNo === missingAck[0])?.skipCode || "MANUAL_REVIEW_REQUIRED",
          `还有 ${missingAck.length} 笔待核对没有确认排除`,
          422,
        );
      }
      const included = input.items.filter((item) =>
        view.skipped.some((line) => line.sourceType === item.type && line.sourceId === item.id),
      );
      if (included.length) {
        throw new ReconciliationError("MANUAL_REVIEW_REQUIRED", "待核对明细不能纳入这次批次", 422);
      }
      const totals = view.openTotals;
      const hashValue = snapshotHash(view.open);
      const now = new Date().toISOString();
      const [batch] = await tx
        .insert(agentReconciliationBatches)
        .values({
          batchNo: newOrderNo("RC"),
          agentId: input.agentId,
          cutoffAt: input.cutoffAt,
          currency: "CNY",
          storeEarningCents: totals.storeEarningCents,
          adjustmentCents: totals.adjustmentCents,
          drawDebtCents: totals.drawDebtCents,
          netCents: totals.netCents,
          storeCount: totals.storeCount,
          adjustmentCount: totals.adjustmentCount,
          drawCount: totals.drawCount,
          direction: totals.direction,
          status: "draft",
          snapshotHash: hashValue,
          version: 1,
          createdBy: input.actor.id,
          createdAt: now,
        })
        .returning();
      if (!batch) throw new ReconciliationError("INVALID_STATE", "批次没有写成", 500);
      for (const line of view.open) {
        try {
          await tx.insert(agentReconciliationClaims).values({
            sourceType: line.sourceType,
            sourceId: line.sourceId,
            batchId: batch.id,
            claimState: "active",
            createdAt: now,
          });
        } catch (error) {
          if (/agent_reconciliation_claims/i.test(String(error))) {
            throw new ReconciliationError("ITEM_ALREADY_CLAIMED", "有明细刚被另一笔批次占用", 409);
          }
          throw error;
        }
        await tx.insert(agentReconciliationItems).values({
          batchId: batch.id,
          agentId: input.agentId,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          sourceVersion: line.sourceVersion,
          amountCents: line.amountCents,
          direction: lineDirection(line.sourceType, line.amountCents),
          sourceOrderNo: line.orderNo,
          snapshotJson: JSON.stringify(line.snapshot),
          createdAt: now,
        });
      }
      const earningIds = view.open.filter((line) => line.sourceType === "earning").map((line) => line.sourceId);
      const adjustmentIds = view.open.filter((line) => line.sourceType === "adjustment").map((line) => line.sourceId);
      if (earningIds.length) {
        const claimed = await tx
          .update(agentEarnings)
          .set({ status: "settling" })
          .where(and(
            inArray(agentEarnings.id, earningIds),
            eq(agentEarnings.status, "pending"),
            sql`EXISTS (
              SELECT 1 FROM store_orders
              WHERE store_orders.id = ${agentEarnings.orderId}
                AND store_orders.pay_status = 'paid'
            )`,
          ))
          .returning({ id: agentEarnings.id });
        if (claimed.length !== earningIds.length) {
          throw new ReconciliationError("SNAPSHOT_CHANGED", "收益状态变了，请重新预览", 409);
        }
      }
      if (adjustmentIds.length) {
        const claimed = await tx
          .update(agentEarningAdjustments)
          .set({ status: "settling" })
          .where(and(
            inArray(agentEarningAdjustments.id, adjustmentIds),
            eq(agentEarningAdjustments.status, "pending"),
            // Recheck at claim time: refund may have won after loadLines.
            sql`EXISTS (
              SELECT 1 FROM store_orders
              WHERE store_orders.id = ${agentEarningAdjustments.orderId}
                AND store_orders.pay_status != 'refunding'
            )`,
          ))
          .returning({ id: agentEarningAdjustments.id });
        if (claimed.length !== adjustmentIds.length) {
          throw new ReconciliationError("SNAPSHOT_CHANGED", "调整状态变了，请重新预览", 409);
        }
      }
      const body = {
        id: batch.id,
        batchNo: batch.batchNo,
        status: "draft",
        version: 1,
        snapshotHash: hashValue,
        netCents: totals.netCents,
        direction: totals.direction,
        itemCount: totals.itemCount,
      };
      await audit(tx, {
        actor: input.actor,
        ip: input.ip,
        action: "reconciliation.create",
        targetId: batch.id,
        before: null,
        after: body,
        batchId: batch.id,
      });
      await finishIdempotency(tx, input.actor.id, "create", input.idempotencyKey, 201, body);
      return { status: 201, body };
    });
  } catch (error) {
    if (isIdempotencyRace(error)) {
      return readFinished(input.actor.id, "create", input.idempotencyKey, hash);
    }
    throw error;
  }
}

async function loadBatch(tx: Tx, id: number) {
  const batch = await tx.query.agentReconciliationBatches.findFirst({
    where: eq(agentReconciliationBatches.id, id),
  });
  if (!batch) throw new ReconciliationError("INVALID_STATE", "批次不存在", 404);
  return batch;
}

/**
 * 快照稳定性：状态、金额必须和快照一致；新批次（sourceVersion 为 sha256 指纹）还要求金额相关字段指纹一致。
 * 旧批次 sourceVersion 是 updatedAt 时间串，只校验状态与金额，避免与金额无关的写入卡死批次。
 */
function versionMatches(snapshotVersion: string, current: string) {
  return !isFingerprintVersion(snapshotVersion) || snapshotVersion === current;
}

async function assertSourcesStable(tx: Tx, batchId: number) {
  const items = await tx
    .select()
    .from(agentReconciliationItems)
    .where(eq(agentReconciliationItems.batchId, batchId));
  for (const item of items) {
    if (item.sourceType === "earning") {
      const row = await tx.query.agentEarnings.findFirst({ where: eq(agentEarnings.id, item.sourceId) });
      if (!row || row.status !== "settling" || row.earningCents !== item.amountCents ||
          !versionMatches(item.sourceVersion, earningFingerprint(row))) {
        throw new ReconciliationError("SNAPSHOT_CHANGED", "已纳入的收益变了，请取消后重新生成", 409);
      }
    } else if (item.sourceType === "adjustment") {
      const row = await tx.query.agentEarningAdjustments.findFirst({
        where: eq(agentEarningAdjustments.id, item.sourceId),
      });
      if (!row || row.status !== "settling" || row.amountCents !== item.amountCents ||
          !versionMatches(item.sourceVersion, adjustmentFingerprint(row))) {
        throw new ReconciliationError("SNAPSHOT_CHANGED", "已纳入的调整变了，请取消后重新生成", 409);
      }
    } else {
      const row = await tx.query.agentDrawItems.findFirst({ where: eq(agentDrawItems.id, item.sourceId) });
      if (!row || row.status !== "unsettled" || row.amountCents !== item.amountCents ||
          !versionMatches(item.sourceVersion, drawItemFingerprint(row))) {
        throw new ReconciliationError("SNAPSHOT_CHANGED", "已纳入的提卡变了，请取消后重新生成", 409);
      }
    }
  }
  return items;
}

function assertVersion(batch: { version: number; snapshotHash: string }, expectedVersion: number, hash: string) {
  if (batch.version !== expectedVersion || batch.snapshotHash !== hash) {
    throw new ReconciliationError("SNAPSHOT_CHANGED", "批次版本变了，请刷新后再操作", 409);
  }
}

export async function patchReconciliation(input: {
  actor: Actor;
  ip: string;
  idempotencyKey: string;
  id: number;
  action: "confirm" | "cancel" | "mark_paid" | "clear";
  expectedVersion: number;
  snapshotHash: string;
  body: Record<string, unknown>;
}) {
  const hash = payloadHash(input.action, { id: input.id, ...input.body });
  try {
    return await db.transaction(async (tx) => {
      const done = await replay(tx, input.actor.id, input.action, input.idempotencyKey, hash);
      if (done) return done;
      await holdIdempotency(tx, input.actor.id, input.action, input.idempotencyKey, hash);
      const batch = await loadBatch(tx, input.id);
      assertVersion(batch, input.expectedVersion, input.snapshotHash);
      const now = new Date().toISOString();
      let body: Record<string, unknown>;
      if (input.action === "confirm") {
        if (batch.status !== "draft") throw new ReconciliationError("INVALID_STATE", "只有待核对批次可以确认", 409);
        await assertSourcesStable(tx, batch.id);
        const confirmed = await tx
          .update(agentReconciliationBatches)
          .set({ status: "pending_payment", version: batch.version + 1 })
          .where(and(
            eq(agentReconciliationBatches.id, batch.id),
            eq(agentReconciliationBatches.version, batch.version),
            eq(agentReconciliationBatches.status, "draft"),
          ))
          .returning({ id: agentReconciliationBatches.id });
        if (!confirmed.length) {
          throw new ReconciliationError("SNAPSHOT_CHANGED", "批次刚被别人改过，请刷新后再操作", 409);
        }
        body = { id: batch.id, status: "pending_payment", version: batch.version + 1, snapshotHash: batch.snapshotHash };
      } else if (input.action === "cancel") {
        if (batch.status !== "draft" && batch.status !== "pending_payment") {
          throw new ReconciliationError("BATCH_NOT_CANCELLABLE", "已付款或已结清的批次不能取消", 409);
        }
        // 先抢占批次状态，再释放来源；没抢到说明并发改过，整笔回滚。
        const cancelled = await tx
          .update(agentReconciliationBatches)
          .set({ status: "cancelled", cancelledAt: now, version: batch.version + 1 })
          .where(and(
            eq(agentReconciliationBatches.id, batch.id),
            eq(agentReconciliationBatches.version, batch.version),
            eq(agentReconciliationBatches.status, batch.status),
          ))
          .returning({ id: agentReconciliationBatches.id });
        if (!cancelled.length) {
          throw new ReconciliationError("SNAPSHOT_CHANGED", "批次刚被别人改过，请刷新后再操作", 409);
        }
        const items = await tx
          .select()
          .from(agentReconciliationItems)
          .where(eq(agentReconciliationItems.batchId, batch.id));
        await tx
          .delete(agentReconciliationClaims)
          .where(and(eq(agentReconciliationClaims.batchId, batch.id), eq(agentReconciliationClaims.claimState, "active")));
        const earningIds = items.filter((item) => item.sourceType === "earning").map((item) => item.sourceId);
        const adjustmentIds = items.filter((item) => item.sourceType === "adjustment").map((item) => item.sourceId);
        if (earningIds.length) {
          await tx
            .update(agentEarnings)
            .set({ status: "pending", settlementId: null, updatedAt: now })
            .where(and(inArray(agentEarnings.id, earningIds), eq(agentEarnings.status, "settling")));
        }
        if (adjustmentIds.length) {
          await tx
            .update(agentEarningAdjustments)
            .set({ status: "pending", settlementId: null, updatedAt: now })
            .where(and(inArray(agentEarningAdjustments.id, adjustmentIds), eq(agentEarningAdjustments.status, "settling")));
        }
        body = { id: batch.id, status: "cancelled", version: batch.version + 1 };
      } else if (input.action === "clear") {
        const check = validateClear({
          netCents: batch.netCents,
          hasPaymentFields: PAYMENT_FIELDS.some((key) => input.body[key] !== undefined && input.body[key] !== ""),
        });
        if (!check.ok) throw new ReconciliationError(check.code, check.message, 422);
        body = await settleBatch(tx, batch, input.actor, now, "cleared", {});
      } else {
        const check = validateMarkPaid({
          netCents: batch.netCents,
          direction: String(input.body.direction || ""),
          currency: String(input.body.currency || ""),
          amountCents: Number(input.body.amountCents),
          paymentMethod: String(input.body.paymentMethod || ""),
          paymentReference: String(input.body.paymentReference || ""),
          actualPaymentAt: String(input.body.actualPaymentAt || ""),
        });
        if (!check.ok) throw new ReconciliationError(check.code, check.message, 422);
        body = await settleBatch(tx, batch, input.actor, now, "paid", {
          paymentMethod: String(input.body.paymentMethod),
          paymentReference: String(input.body.paymentReference).trim(),
          paymentNote: String(input.body.note || ""),
          actualPaymentAt: String(input.body.actualPaymentAt),
        });
      }
      await audit(tx, {
        actor: input.actor,
        ip: input.ip,
        action: `reconciliation.${input.action}`,
        targetId: batch.id,
        before: { status: batch.status, version: batch.version },
        after: body,
        batchId: batch.id,
      });
      const status = 200;
      await finishIdempotency(tx, input.actor.id, input.action, input.idempotencyKey, status, body);
      return { status, body };
    });
  } catch (error) {
    if (isIdempotencyRace(error)) return readFinished(input.actor.id, input.action, input.idempotencyKey, hash);
    throw error;
  }
}

async function settleBatch(
  tx: Tx,
  batch: typeof agentReconciliationBatches.$inferSelect,
  actor: Actor,
  now: string,
  status: "paid" | "cleared",
  payment: {
    paymentMethod?: string;
    paymentReference?: string;
    paymentNote?: string;
    actualPaymentAt?: string;
  },
) {
  if (batch.status !== "pending_payment") {
    throw new ReconciliationError("INVALID_STATE", "先确认批次，再登记", 409);
  }
  const items = await assertSourcesStable(tx, batch.id);
  const earningIds = items.filter((item) => item.sourceType === "earning").map((item) => item.sourceId);
  const adjustmentIds = items.filter((item) => item.sourceType === "adjustment").map((item) => item.sourceId);
  const drawIds = items.filter((item) => item.sourceType === "draw_item").map((item) => item.sourceId);
  // 兼容镜像：只给含商店收益/调整的批次写，金额按商店侧口径（收益 + 调整），供旧导出和 settlementId 关联。
  // 纯提卡批次不写，避免旧导出把提卡欠款当返佣。settlementNo = batchNo 用于识别镜像。
  let legacy: typeof agentSettlements.$inferSelect | undefined;
  if (earningIds.length || adjustmentIds.length) {
    const storeSideCents = batch.storeEarningCents + batch.adjustmentCents;
    const netText = `${directionLabel(directionOf(batch.netCents))} ¥${(Math.abs(batch.netCents) / 100).toFixed(2)}`;
    [legacy] = await tx
      .insert(agentSettlements)
      .values({
        settlementNo: batch.batchNo,
        agentId: batch.agentId,
        periodStart: batch.cutoffAt,
        periodEnd: batch.cutoffAt,
        amountCents: storeSideCents,
        itemCount: earningIds.length + adjustmentIds.length,
        status: "paid",
        paymentMethod: payment.paymentMethod || "",
        paymentReference: payment.paymentReference || "",
        notes: `对账批次 ${batch.batchNo}，净额 ${netText}`,
        createdBy: actor.id,
        createdAt: now,
        paidAt: now,
      })
      .returning();
  }
  if (earningIds.length) {
    const updated = await tx
      .update(agentEarnings)
      .set({ status: "settled", settlementId: legacy?.id ?? null, updatedAt: now })
      .where(and(inArray(agentEarnings.id, earningIds), eq(agentEarnings.status, "settling")))
      .returning({ id: agentEarnings.id });
    if (updated.length !== earningIds.length) {
      throw new ReconciliationError("SNAPSHOT_CHANGED", "收益状态变了，没有登记", 409);
    }
  }
  if (adjustmentIds.length) {
    const updated = await tx
      .update(agentEarningAdjustments)
      .set({ status: "settled", settlementId: legacy?.id ?? null, updatedAt: now })
      .where(and(inArray(agentEarningAdjustments.id, adjustmentIds), eq(agentEarningAdjustments.status, "settling")))
      .returning({ id: agentEarningAdjustments.id });
    if (updated.length !== adjustmentIds.length) {
      throw new ReconciliationError("SNAPSHOT_CHANGED", "调整状态变了，没有登记", 409);
    }
    const corrections = await tx
      .select()
      .from(agentReconciliationCorrections)
      .where(inArray(agentReconciliationCorrections.newAdjustmentId, adjustmentIds));
    for (const correction of corrections) {
      await tx
        .update(agentReconciliationCorrections)
        .set({ status: "applied", newBatchId: batch.id })
        .where(eq(agentReconciliationCorrections.id, correction.id));
      const pendingLeft = await tx
        .select({ id: agentReconciliationCorrections.id })
        .from(agentReconciliationCorrections)
        .where(
          and(
            eq(agentReconciliationCorrections.originalBatchId, correction.originalBatchId),
            eq(agentReconciliationCorrections.status, "pending"),
          ),
        );
      if (!pendingLeft.length) {
        await tx
          .update(agentReconciliationBatches)
          .set({ status: "corrected" })
          .where(
            and(
              eq(agentReconciliationBatches.id, correction.originalBatchId),
              eq(agentReconciliationBatches.status, "correction_pending"),
            ),
          );
      }
    }
  }
  if (drawIds.length) {
    const updated = await tx
      .update(agentDrawItems)
      .set({ status: "settled", settledAt: now, updatedAt: now })
      .where(and(inArray(agentDrawItems.id, drawIds), eq(agentDrawItems.status, "unsettled")))
      .returning({ id: agentDrawItems.id });
    if (updated.length !== drawIds.length) {
      throw new ReconciliationError("SNAPSHOT_CHANGED", "提卡状态变了，没有登记", 409);
    }
  }
  await tx
    .update(agentReconciliationClaims)
    .set({ claimState: "settled" })
    .where(eq(agentReconciliationClaims.batchId, batch.id));
  const finished = await tx
    .update(agentReconciliationBatches)
    .set({
      status,
      version: batch.version + 1,
      paidAt: now,
      paymentMethod: payment.paymentMethod || "",
      paymentReference: payment.paymentReference || "",
      paymentNote: payment.paymentNote || "",
      actualPaymentAt: payment.actualPaymentAt || null,
    })
    .where(and(
      eq(agentReconciliationBatches.id, batch.id),
      eq(agentReconciliationBatches.version, batch.version),
      eq(agentReconciliationBatches.status, "pending_payment"),
    ))
    .returning({ id: agentReconciliationBatches.id });
  if (!finished.length) {
    throw new ReconciliationError("SNAPSHOT_CHANGED", "批次刚被别人改过，没有登记", 409);
  }
  return {
    id: batch.id,
    status,
    version: batch.version + 1,
    netCents: batch.netCents,
    direction: batch.direction,
    paymentReference: payment.paymentReference || "",
  };
}

export async function addCorrection(input: {
  actor: Actor;
  ip: string;
  idempotencyKey: string;
  batchId: number;
  sourceItemId: number;
  type: CorrectionApiType;
  amountCents: number;
  reason: string;
  reference: string;
  businessEventKey: string;
  expectedCorrectionSequence: number;
}) {
  const hash = payloadHash("correction", { ...input, actor: undefined, ip: undefined });
  try {
    return await db.transaction(async (tx) => {
      const done = await replay(tx, input.actor.id, "correction", input.idempotencyKey, hash);
      if (done) return done;
      await holdIdempotency(tx, input.actor.id, "correction", input.idempotencyKey, hash);
      const batch = await loadBatch(tx, input.batchId);
      if (!["paid", "cleared", "correction_pending", "corrected"].includes(batch.status)) {
        throw new ReconciliationError("INVALID_STATE", "只有已结批次可以记更正", 409);
      }
      const item = await tx.query.agentReconciliationItems.findFirst({
        where: and(eq(agentReconciliationItems.id, input.sourceItemId), eq(agentReconciliationItems.batchId, batch.id)),
      });
      if (!item) throw new ReconciliationError("INVALID_STATE", "更正必须指向这个批次里的明细", 404);
      const snapshot = JSON.parse(item.snapshotJson) as { orderId?: number };
      const orderId = snapshot.orderId || 0;
      if (!orderId) throw new ReconciliationError("INVALID_STATE", "这条明细没有关联订单，不能更正", 422);
      const earning = await tx.query.agentEarnings.findFirst({ where: eq(agentEarnings.orderId, orderId) });
      if (!earning) throw new ReconciliationError("MISSING_SOURCE", "原收益行不在了", 422);
      const adjustType = adjustmentTypeForCorrection(input.type);
      if (item.agentId !== batch.agentId || earning.agentId !== batch.agentId ||
          (item.sourceType === "earning" && item.sourceId !== earning.id)) {
        throw new ReconciliationError("MISSING_SOURCE", "原明细和收益来源身份不一致", 422);
      }
      if (item.sourceType === "adjustment") {
        const source = await tx.query.agentEarningAdjustments.findFirst({
          where: eq(agentEarningAdjustments.id, item.sourceId),
        });
        if (!source || source.agentId !== batch.agentId || source.orderId !== orderId || source.sourceEarningId !== earning.id) {
          throw new ReconciliationError("MISSING_SOURCE", "原调整来源身份不一致", 422);
        }
      } else if (item.sourceType !== "earning") {
        throw new ReconciliationError("INVALID_STATE", "这条来源不能作订单更正", 422);
      }
      const existingEvent = await tx.query.agentEarningAdjustments.findFirst({
        where: eq(agentEarningAdjustments.businessEventKey, input.businessEventKey),
      });
      if (existingEvent) {
        if (
          existingEvent.agentId !== batch.agentId ||
          existingEvent.orderId !== orderId ||
          existingEvent.sourceEarningId !== earning.id ||
          existingEvent.type !== adjustType ||
          existingEvent.amountCents !== input.amountCents ||
          existingEvent.reason !== input.reason ||
          existingEvent.reference !== input.reference
        ) {
          throw new ReconciliationError("ADJUSTMENT_EVENT_CONFLICT", "同一个账务事件来源或金额不能改变", 409);
        }
        const correction = await tx.query.agentReconciliationCorrections.findFirst({
          where: eq(agentReconciliationCorrections.newAdjustmentId, existingEvent.id),
        });
        if (existingEvent.originalBatchId !== batch.id || !correction ||
            correction.originalBatchId !== batch.id || correction.sourceItemId !== item.id ||
            correction.originalOrderId !== orderId || correction.type !== input.type ||
            correction.sequence !== existingEvent.sequence ||
            existingEvent.sequence !== input.expectedCorrectionSequence) {
          throw new ReconciliationError("ADJUSTMENT_EVENT_CONFLICT", "同一个账务事件不能改换来源明细", 409);
        }
        const body = {
          correctionId: correction.id,
          sequence: existingEvent.sequence,
          originalBatchId: batch.id,
          newAdjustmentId: existingEvent.id,
          status: "pending",
          amountCents: existingEvent.amountCents,
        };
        await finishIdempotency(tx, input.actor.id, "correction", input.idempotencyKey, 201, body);
        return { status: 201, body };
      }
      // 已退款/退款中/拒付的订单不能被正数更正「复活」收益。
      const order = await tx.query.storeOrders.findFirst({
        where: eq(storeOrders.id, orderId),
        columns: { payStatus: true },
      });
      if (!order) throw new ReconciliationError("MISSING_SOURCE", "订单不在了", 422);
      const revive = checkNoRevive(order.payStatus, input.amountCents);
      if (!revive.ok) throw new ReconciliationError(revive.code, revive.message, 422);
      // 写入前在同一事务内算当前有效收益，防止更正超额重复扣钱。
      const effective = await effectiveEarningCents(tx, orderId, earning.earningCents);
      const amountCheck = checkCorrectionAmount(input.type, input.amountCents, effective);
      if (!amountCheck.ok) {
        throw new ReconciliationError(amountCheck.code, amountCheck.message, 422);
      }
      const prior = await tx
        .select({ sequence: agentEarningAdjustments.sequence })
        .from(agentEarningAdjustments)
        .where(and(eq(agentEarningAdjustments.orderId, orderId), eq(agentEarningAdjustments.type, adjustType)));
      const sequence = assertCorrectionSequence(
        prior.map((row) => row.sequence),
        input.expectedCorrectionSequence,
      );
      if (!sequence.ok) {
        throw new ReconciliationError("CORRECTION_SEQUENCE_CONFLICT", `下一序号是 ${sequence.next}`, 409);
      }
      const now = new Date().toISOString();
      const [adjustment] = await tx
        .insert(agentEarningAdjustments)
        .values({
          agentId: batch.agentId,
          orderId,
          sourceEarningId: earning.id,
          type: adjustType,
          amountCents: input.amountCents,
          reason: input.reason,
          reference: input.reference,
          status: "pending",
          sequence: sequence.next,
          businessEventKey: input.businessEventKey,
          originalBatchId: batch.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!adjustment) throw new ReconciliationError("INVALID_STATE", "调整没有写成", 500);
      const [correction] = await tx
        .insert(agentReconciliationCorrections)
        .values({
          originalBatchId: batch.id,
          sourceItemId: item.id,
          originalOrderId: orderId,
          sequence: sequence.next,
          type: input.type,
          reason: input.reason,
          reference: input.reference,
          newAdjustmentId: adjustment.id,
          status: "pending",
          createdBy: input.actor.id,
          createdAt: now,
        })
        .returning();
      if (batch.status === "paid" || batch.status === "cleared" || batch.status === "corrected") {
        await tx
          .update(agentReconciliationBatches)
          .set({ status: "correction_pending" })
          .where(eq(agentReconciliationBatches.id, batch.id));
      }
      const body = {
        correctionId: correction?.id,
        sequence: sequence.next,
        originalBatchId: batch.id,
        newAdjustmentId: adjustment.id,
        status: "pending",
        amountCents: input.amountCents,
      };
      await audit(tx, {
        actor: input.actor,
        ip: input.ip,
        action: "reconciliation.correction",
        targetId: batch.id,
        before: { status: batch.status },
        after: body,
        batchId: batch.id,
      });
      await finishIdempotency(tx, input.actor.id, "correction", input.idempotencyKey, 201, body);
      return { status: 201, body };
    });
  } catch (error) {
    if (/agent_earning_adjustments_event_key_uq|business_event_key/i.test(String(error))) {
      throw new ReconciliationError("ADJUSTMENT_EVENT_CONFLICT", "这个账务事件已经记过", 409);
    }
    if (/agent_earning_adjustments_order_type_seq_uq|sequence/i.test(String(error))) {
      throw new ReconciliationError("CORRECTION_SEQUENCE_CONFLICT", "序号刚被占用，刷新后再提交", 409);
    }
    if (isIdempotencyRace(error)) return readFinished(input.actor.id, "correction", input.idempotencyKey, hash);
    throw error;
  }
}

export async function listReconciliationAgents(query: {
  search: string;
  status: string;
  sort: string;
  cursor: string;
  limit: number;
  cutoffAt: string;
}) {
  const rows = await db
    .select({ id: agents.id, name: agents.displayName, shopName: agents.shopName })
    .from(agents)
    .orderBy(agents.displayName);
  const taggedLines = await collectLines(db, null, query.cutoffAt);
  const batchRows = await db.select().from(agentReconciliationBatches).orderBy(desc(agentReconciliationBatches.id));
  const claimRows = await db
    .select({ agentId: agentReconciliationBatches.agentId })
    .from(agentReconciliationClaims)
    .innerJoin(agentReconciliationBatches, eq(agentReconciliationBatches.id, agentReconciliationClaims.batchId))
    .where(eq(agentReconciliationClaims.claimState, "active"));
  const linesByAgent = new Map<number, Line[]>();
  for (const row of taggedLines) {
    const bucket = linesByAgent.get(row.agentId);
    if (bucket) bucket.push(row.line);
    else linesByAgent.set(row.agentId, [row.line]);
  }
  const batchesByAgent = new Map<number, typeof batchRows>();
  for (const batch of batchRows) {
    const bucket = batchesByAgent.get(batch.agentId);
    if (bucket) bucket.push(batch);
    else batchesByAgent.set(batch.agentId, [batch]);
  }
  const claimedAgents = new Set(claimRows.map((row) => row.agentId));
  const listed = [];
  for (const agent of rows) {
    const name = agent.shopName || agent.name;
    if (query.search && !name.toLowerCase().includes(query.search.toLowerCase()) && !agent.name.includes(query.search)) {
      continue;
    }
    const view = partition(linesByAgent.get(agent.id) || []);
    const batches = batchesByAgent.get(agent.id) || [];
    const latest = batches[0];
    const activeClaims = claimedAgents.has(agent.id) ? [agent.id] : [];
    const open = view.openTotals.itemCount > 0;
    const pending = batches.some(
      (batch) => batch.status === "draft" || batch.status === "pending_payment" || batch.status === "correction_pending",
    );
    // A group is cleared only when every batch is terminal and no source remains
    // open, skipped, or actively claimed/locked by an unsettled batch.
    const cleared = !open && !view.lockedTotals.itemCount && !activeClaims.length && !view.skipped.length && !pending;
    const review = view.skipped.length > 0;
    if (query.status === "balance" && !open) continue;
    if (query.status === "pending_payment" && !pending) continue;
    if (query.status === "cleared" && !cleared) continue;
    if (query.status === "review" && !review) continue;
    if (!open && !pending && !review && !latest) continue;
    listed.push({
      agentId: agent.id,
      name,
      storeEarningCents: view.openTotals.storeEarningCents,
      adjustmentCents: view.openTotals.adjustmentCents,
      drawDebtCents: view.openTotals.drawDebtCents,
      netCents: view.openTotals.netCents,
      direction: view.openTotals.direction,
      itemCount: view.openTotals.itemCount,
      skippedCount: view.skipped.length,
      lockedNetCents: view.lockedTotals.netCents,
      latestBatch: latest
        ? {
            id: latest.id,
            batchNo: latest.batchNo,
            status: latest.status,
            netCents: latest.netCents,
            storeEarningCents: latest.storeEarningCents,
            adjustmentCents: latest.adjustmentCents,
            drawDebtCents: latest.drawDebtCents,
            storeCount: latest.storeCount,
            adjustmentCount: latest.adjustmentCount,
            drawCount: latest.drawCount,
            version: latest.version,
            snapshotHash: latest.snapshotHash,
          }
        : null,
      updatedAt: view.open[0]?.occurredAt || latest?.createdAt || "",
    });
  }
  listed.sort((a, b) => {
    if (query.sort === "name") return a.name.localeCompare(b.name, "zh");
    if (query.sort === "updated") return b.updatedAt.localeCompare(a.updatedAt);
    return Math.abs(b.netCents) - Math.abs(a.netCents);
  });
  const offset = query.cursor ? Number(query.cursor) || 0 : 0;
  const page = listed.slice(offset, offset + query.limit);
  const payable = listed
    .filter((row) => row.netCents > 0)
    .reduce((sum, row) => sum + row.netCents, 0);
  const receivable = listed
    .filter((row) => row.netCents < 0)
    .reduce((sum, row) => sum + row.netCents, 0);
  return {
    cutoffAt: query.cutoffAt,
    currency: "CNY" as const,
    summary: {
      openAgents: listed.filter((row) => row.itemCount > 0).length,
      platformPaysCents: payable,
      agentPaysCents: receivable,
      reviewOrders: listed.reduce((sum, row) => sum + row.skippedCount, 0),
    },
    list: page,
    nextCursor: offset + query.limit < listed.length ? String(offset + query.limit) : null,
  };
}

export async function getReconciliation(id: number, agentId?: number) {
  const batch = await db.query.agentReconciliationBatches.findFirst({
    where: eq(agentReconciliationBatches.id, id),
  });
  if (!batch || (agentId && batch.agentId !== agentId)) return null;
  const audits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.targetType, "agent_reconciliation_batch"), eq(auditLogs.targetId, String(id))))
    .orderBy(desc(auditLogs.id));
  return { batch, audits };
}

export async function listReconciliationItems(id: number, agentId: number | undefined, cursor: number, limit: number, type: string) {
  const batch = await db.query.agentReconciliationBatches.findFirst({
    where: eq(agentReconciliationBatches.id, id),
  });
  if (!batch || (agentId && batch.agentId !== agentId)) return null;
  const conditions = [eq(agentReconciliationItems.batchId, id)];
  if (type) conditions.push(eq(agentReconciliationItems.sourceType, type));
  const rows = await db
    .select()
    .from(agentReconciliationItems)
    .where(and(...conditions))
    .orderBy(agentReconciliationItems.id)
    .offset(cursor)
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    batchNo: batch.batchNo,
    snapshotHash: batch.snapshotHash,
    items: page.map((row) => ({
      ...row,
      snapshot: JSON.parse(row.snapshotJson) as Record<string, unknown>,
    })),
    nextCursor: rows.length > limit ? cursor + limit : null,
  };
}

export function itemsCsv(batchNo: string, hash: string, items: Array<{ sourceOrderNo: string; sourceType: string; amountCents: number; snapshotJson: string }>) {
  const header = ["batchNo", "snapshotHash", "orderNo", "type", "amountCents", "snapshot"].join(",");
  const lines = items.map((item) =>
    [batchNo, hash, item.sourceOrderNo, item.sourceType, item.amountCents, item.snapshotJson]
      .map((value) => {
        const text = String(value);
        const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
        return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
      })
      .join(","),
  );
  return `\uFEFF${header}\n${lines.join("\n")}\n`;
}

export async function agentLedger(agentId: number, cutoffAt: string) {
  const preview = await previewReconciliation(agentId, cutoffAt);
  return preview;
}

/**
 * 代理端批次视图：只给前端要展示的字段。
 * 不含 agentId、periodLabel、snapshotHash、createdBy、paymentNote 这些内部字段。
 */
export function agentBatchView(batch: typeof agentReconciliationBatches.$inferSelect) {
  return {
    id: batch.id,
    batchNo: batch.batchNo,
    status: batch.status,
    cutoffAt: batch.cutoffAt,
    currency: batch.currency,
    direction: batch.direction,
    netCents: batch.netCents,
    storeEarningCents: batch.storeEarningCents,
    adjustmentCents: batch.adjustmentCents,
    drawDebtCents: batch.drawDebtCents,
    storeCount: batch.storeCount,
    adjustmentCount: batch.adjustmentCount,
    drawCount: batch.drawCount,
    version: batch.version,
    createdAt: batch.createdAt,
    paidAt: batch.paidAt,
    cancelledAt: batch.cancelledAt,
    paymentMethod: batch.paymentMethod,
    paymentReference: batch.paymentReference,
    actualPaymentAt: batch.actualPaymentAt,
  };
}

export async function listAgentBatches(agentId: number, cursor: number, limit: number) {
  const rows = await db
    .select()
    .from(agentReconciliationBatches)
    .where(eq(agentReconciliationBatches.agentId, agentId))
    .orderBy(desc(agentReconciliationBatches.id))
    .offset(cursor)
    .limit(limit + 1);
  return {
    list: rows.slice(0, limit),
    nextCursor: rows.length > limit ? cursor + limit : null,
  };
}

export function batchNet(store: number, adjustment: number, draw: number) {
  return netCents({ storeEarningCents: store, adjustmentCents: adjustment, drawDebtCents: draw });
}

/** 旧退款/差额入口继续按「同一订单同一类型只记一笔」去重，新更正走业务事件键。 */
/** 原收益和仍有效的调整组成同一基线；撤销/冲回行不再生效。 */
export function effectiveAdjustmentCents(
  earningCents: number,
  adjustments: Array<{ amountCents: number; status: string }>,
) {
  return earningCents + adjustments
    .filter((row) => ["pending", "settling", "settled"].includes(row.status))
    .reduce((sum, row) => sum + row.amountCents, 0);
}

export async function effectiveEarningCents(
  tx: Tx | typeof db,
  orderId: number,
  earningCents: number,
) {
  const rows = await tx
    .select({ amountCents: agentEarningAdjustments.amountCents, status: agentEarningAdjustments.status })
    .from(agentEarningAdjustments)
    .where(
      and(
        eq(agentEarningAdjustments.orderId, orderId),
        inArray(agentEarningAdjustments.status, ["pending", "settling", "settled"]),
      ),
    );
  return effectiveAdjustmentCents(earningCents, rows);
}

export async function insertLegacyAdjustment(
  tx: Tx | typeof db,
  values: {
    agentId: number;
    orderId: number;
    sourceEarningId: number;
    type: string;
    amountCents: number;
    reason: string;
    reference?: string;
    now: string;
  },
) {
  const businessEventKey = `legacy:${values.type}:${values.orderId}`;
  const existing = await tx.query.agentEarningAdjustments.findFirst({
    where: eq(agentEarningAdjustments.businessEventKey, businessEventKey),
  });
  if (existing) return existing;
  const prior = await tx
    .select({ sequence: agentEarningAdjustments.sequence })
    .from(agentEarningAdjustments)
    .where(and(eq(agentEarningAdjustments.orderId, values.orderId), eq(agentEarningAdjustments.type, values.type)));
  const sequence = (prior.reduce((top, row) => Math.max(top, row.sequence), 0) || 0) + 1;
  const [created] = await tx
    .insert(agentEarningAdjustments)
    .values({
      agentId: values.agentId,
      orderId: values.orderId,
      sourceEarningId: values.sourceEarningId,
      type: values.type,
      amountCents: values.amountCents,
      reason: values.reason,
      reference: values.reference || "",
      status: "pending",
      sequence,
      businessEventKey,
      createdAt: values.now,
      updatedAt: values.now,
    })
    .returning();
  return created ?? null;
}

export type OrderAdjustmentInput = {
  agentId: number;
  orderId: number;
  sourceEarningId: number;
  /** 调整表类型：refund | reversal | fee_correction | manual | chargeback ... */
  type: string;
  amountCents: number;
  reason: string;
  reference: string;
  businessEventKey: string;
  now: string;
  originalBatchId?: number | null;
};

/**
 * 通用订单调整写入（须在调用方事务内调用）。
 * - 同一 businessEventKey 已存在：内容一致返回 replayed=true，不一致抛 ADJUSTMENT_EVENT_CONFLICT；
 * - 否则在 (orderId, type) 上分配 max(sequence)+1 写入 pending 调整；
 * - 写入前校验：金额非 0、写入后有效收益 ≥ 0，否则抛 CORRECTION_EXCEEDS_EARNING。
 */
export async function insertOrderAdjustment(
  tx: Tx | typeof db,
  input: OrderAdjustmentInput,
): Promise<{ adjustment: typeof agentEarningAdjustments.$inferSelect; replayed: boolean }> {
  const businessEventKey = input.businessEventKey.trim();
  if (!businessEventKey) {
    throw new ReconciliationError("INVALID_STATE", "调整缺少业务事件键", 422);
  }
  const originalBatchId = input.originalBatchId ?? null;
  const existing = await tx.query.agentEarningAdjustments.findFirst({
    where: eq(agentEarningAdjustments.businessEventKey, businessEventKey),
  });
  if (existing) {
    if (
      existing.agentId !== input.agentId ||
      existing.orderId !== input.orderId ||
      existing.sourceEarningId !== input.sourceEarningId ||
      existing.type !== input.type ||
      existing.amountCents !== input.amountCents ||
      existing.reason !== input.reason ||
      existing.reference !== input.reference ||
      (existing.originalBatchId ?? null) !== originalBatchId
    ) {
      throw new ReconciliationError("ADJUSTMENT_EVENT_CONFLICT", "同一个账务事件来源或金额不能改变", 409);
    }
    return { adjustment: existing, replayed: true };
  }
  const earning = await tx.query.agentEarnings.findFirst({ where: eq(agentEarnings.id, input.sourceEarningId) });
  if (!earning || earning.orderId !== input.orderId || earning.agentId !== input.agentId) {
    throw new ReconciliationError("MISSING_SOURCE", "原收益行不在了或和订单不一致", 422);
  }
  const order = await tx.query.storeOrders.findFirst({
    where: eq(storeOrders.id, input.orderId),
    columns: { payStatus: true },
  });
  if (!order) throw new ReconciliationError("MISSING_SOURCE", "订单不在了", 422);
  const revive = checkNoRevive(order.payStatus, input.amountCents);
  if (!revive.ok) throw new ReconciliationError(revive.code, revive.message, 422);
  const effective = await effectiveEarningCents(tx, input.orderId, earning.earningCents);
  const check = checkAdjustmentFloor(input.amountCents, effective);
  if (!check.ok) throw new ReconciliationError(check.code, check.message, 422);
  const prior = await tx
    .select({ sequence: agentEarningAdjustments.sequence })
    .from(agentEarningAdjustments)
    .where(and(eq(agentEarningAdjustments.orderId, input.orderId), eq(agentEarningAdjustments.type, input.type)));
  const sequence = prior.reduce((top, row) => Math.max(top, row.sequence), 0) + 1;
  const [adjustment] = await tx
    .insert(agentEarningAdjustments)
    .values({
      agentId: input.agentId,
      orderId: input.orderId,
      sourceEarningId: input.sourceEarningId,
      type: input.type,
      amountCents: input.amountCents,
      reason: input.reason,
      reference: input.reference,
      status: "pending",
      sequence,
      businessEventKey,
      originalBatchId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!adjustment) throw new ReconciliationError("INVALID_STATE", "调整没有写成", 500);
  return { adjustment, replayed: false };
}
