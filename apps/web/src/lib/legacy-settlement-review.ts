/**
 * 旧周结单（agent_settlements）的人工核验：补登已付 / 取消退回。
 * 只用相对导入，测试可以直接在内存 SQLite 上执行（和 payments/fee-lock-db.ts 同一模式）。
 */
import { and, eq, inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  agentEarningAdjustments,
  agentEarnings,
  agentReconciliationBatches,
  agentSettlements,
} from "../db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BaseSQLiteDatabase<"async", any, any>;

export type LegacySettlementAction =
  | { action: "mark_paid"; paymentMethod: string; paymentReference: string }
  | { action: "cancel" };

export const MIRROR_MESSAGE = "这是对账批次的记录，请到对账页处理";
export const BAD_STATE_MESSAGE = "当前结算单状态不可操作";
export const STATE_CHANGED_MESSAGE = "结算单状态已变化，请刷新后重试";

/**
 * 补登已付只认已生成付款单的 pending_payment；draft 还没出付款单，不能直接标已付。
 * 取消两种状态都行：把占用的收益和调整退回未结。
 */
export function allowedFromStatuses(action: LegacySettlementAction["action"]): string[] {
  return action === "mark_paid" ? ["pending_payment"] : ["pending_payment", "draft"];
}

export type LegacySettlementRow = typeof agentSettlements.$inferSelect;

export type LegacySettlementOutcome =
  | {
      kind: "ok";
      settlement: LegacySettlementRow;
      toStatus: "paid" | "cancelled";
      earnings: number;
      adjustments: number;
    }
  | { kind: "not_found" }
  | { kind: "mirror" }
  | { kind: "bad_state" }
  | { kind: "changed" };

class StateChanged extends Error {}

export async function reviewLegacySettlement(
  db: Db,
  id: number,
  input: LegacySettlementAction,
  now: string,
): Promise<LegacySettlementOutcome> {
  const [settlement] = await db.select().from(agentSettlements).where(eq(agentSettlements.id, id)).limit(1);
  if (!settlement) return { kind: "not_found" };
  // 对账付款/抵平会写一行 settlement_no = batch_no 的镜像，归新对账管。
  const [mirror] = await db
    .select({ id: agentReconciliationBatches.id })
    .from(agentReconciliationBatches)
    .where(eq(agentReconciliationBatches.batchNo, settlement.settlementNo))
    .limit(1);
  if (mirror) return { kind: "mirror" };
  const allowed = allowedFromStatuses(input.action);
  if (!allowed.includes(settlement.status)) return { kind: "bad_state" };

  const touched = { earnings: 0, adjustments: 0 };
  try {
    await db.transaction(async (tx) => {
      const claimWhere = and(eq(agentSettlements.id, id), inArray(agentSettlements.status, allowed));
      if (input.action === "mark_paid") {
        const [claimed] = await tx
          .update(agentSettlements)
          .set({
            status: "paid",
            paymentMethod: input.paymentMethod,
            paymentReference: input.paymentReference,
            paidAt: now,
          })
          .where(claimWhere)
          .returning();
        if (!claimed) throw new StateChanged();
        const earnings = await tx
          .update(agentEarnings)
          .set({ status: "settled", updatedAt: now })
          .where(and(eq(agentEarnings.settlementId, id), eq(agentEarnings.status, "settling")))
          .returning({ id: agentEarnings.id });
        const adjustments = await tx
          .update(agentEarningAdjustments)
          .set({ status: "settled", updatedAt: now })
          .where(and(eq(agentEarningAdjustments.settlementId, id), eq(agentEarningAdjustments.status, "settling")))
          .returning({ id: agentEarningAdjustments.id });
        touched.earnings = earnings.length;
        touched.adjustments = adjustments.length;
      } else {
        const [claimed] = await tx
          .update(agentSettlements)
          .set({ status: "cancelled" })
          .where(claimWhere)
          .returning();
        if (!claimed) throw new StateChanged();
        const earnings = await tx
          .update(agentEarnings)
          .set({ settlementId: null, status: "pending", updatedAt: now })
          .where(and(eq(agentEarnings.settlementId, id), eq(agentEarnings.status, "settling")))
          .returning({ id: agentEarnings.id });
        const adjustments = await tx
          .update(agentEarningAdjustments)
          .set({ settlementId: null, status: "pending", updatedAt: now })
          .where(and(eq(agentEarningAdjustments.settlementId, id), eq(agentEarningAdjustments.status, "settling")))
          .returning({ id: agentEarningAdjustments.id });
        touched.earnings = earnings.length;
        touched.adjustments = adjustments.length;
      }
    });
  } catch (error) {
    if (error instanceof StateChanged) return { kind: "changed" };
    throw error;
  }
  return {
    kind: "ok",
    settlement,
    toStatus: input.action === "mark_paid" ? "paid" : "cancelled",
    ...touched,
  };
}
