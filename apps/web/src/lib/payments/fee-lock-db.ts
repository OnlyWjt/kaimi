/**
 * 手续费回写到订单的条件更新。只用相对导入，测试可以直接在内存 SQLite 上执行。
 *
 * 并发保护：每条 UPDATE store_orders 都把「收益是否已锁定」写进 WHERE（EXISTS / NOT EXISTS
 * 子查询），判断和写入是同一条语句，不存在先读后写之间被对账批次抢占的窗口。
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { storeOrders } from "../../db/schema";
import type { LedgerResult } from "../order-ledger-core";
import {
  LOCKED_EARNING_EXISTS_SQL,
  LOCKED_EARNING_FEE_MESSAGE,
  NO_LOCKED_EARNING_SQL,
} from "./fee-lock-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Writer = Pick<BaseSQLiteDatabase<"async", any, any>, "update">;

export type FeeWriteInput = {
  orderId: number;
  reconcilableStatuses: string[];
  /** null = 不记录网关手续费（unsupported 回退分支）。 */
  actualFee: number | null;
  attemptNo: number;
  now: string;
  finalStatus: "confirmed" | "unsupported";
  ledger: LedgerResult;
};

export type FeeWriteOutcome =
  | { kind: "applied" }
  | { kind: "locked"; status: "confirmed" | "unsupported" | "manual_review" }
  | { kind: "skipped" };

/**
 * 收益未锁定（没有收益行，或 pending 且未挂结算单）：改订单金额并定稿状态。
 * 收益已锁定：订单金额字段一律不动，交给 markLockedEarningOrder。
 */
export async function writeOrderFee(tx: Writer, input: FeeWriteInput): Promise<FeeWriteOutcome> {
  const recordFee =
    input.actualFee === null ? {} : { actualPaymentFeeCents: input.actualFee };
  const [updated] = await tx
    .update(storeOrders)
    .set({
      ...recordFee,
      finalPaymentFeeCents: input.ledger.finalPaymentFeeCents,
      agentFeeCents: input.ledger.agentFeeCents,
      platformFeeCents: input.ledger.platformFeeCents,
      agentEarningCents: input.ledger.agentEarningCents,
      platformProfitCents: input.ledger.platformProfitCents,
      feeReconcileStatus: input.finalStatus,
      feeReconcileAttempts: input.attemptNo,
      feeReconcileLastError: "",
      feeReconciledAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(storeOrders.id, input.orderId),
        inArray(storeOrders.feeReconcileStatus, input.reconcilableStatuses),
        sql.raw(NO_LOCKED_EARNING_SQL),
      ),
    )
    .returning({ id: storeOrders.id });
  if (updated) return { kind: "applied" };
  const status = await markLockedEarningOrder(tx, input);
  return status ? { kind: "locked", status } : { kind: "skipped" };
}

/**
 * 收益已锁定时调用。订单金额字段一律不改：
 * - 新算出的金额和订单现有金额完全相同：没有差额，照常定稿状态（不制造无意义的人工单）；
 * - 有差额：转 manual_review，只记网关手续费，差额交给人工 fee_correction。
 * 两条 UPDATE 都带 EXISTS(已锁定收益)；都没命中说明订单状态已被别处改走，返回 undefined。
 */
export async function markLockedEarningOrder(
  tx: Writer,
  input: FeeWriteInput,
): Promise<"confirmed" | "unsupported" | "manual_review" | undefined> {
  const base = and(
    eq(storeOrders.id, input.orderId),
    inArray(storeOrders.feeReconcileStatus, input.reconcilableStatuses),
    sql.raw(LOCKED_EARNING_EXISTS_SQL),
  );
  const recordFee =
    input.actualFee === null ? {} : { actualPaymentFeeCents: input.actualFee };
  const [unchanged] = await tx
    .update(storeOrders)
    .set({
      ...recordFee,
      feeReconcileStatus: input.finalStatus,
      feeReconcileAttempts: input.attemptNo,
      feeReconcileLastError: "",
      feeReconciledAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        base,
        eq(storeOrders.finalPaymentFeeCents, input.ledger.finalPaymentFeeCents),
        eq(storeOrders.agentFeeCents, input.ledger.agentFeeCents),
        eq(storeOrders.platformFeeCents, input.ledger.platformFeeCents),
        eq(storeOrders.agentEarningCents, input.ledger.agentEarningCents),
        input.ledger.platformProfitCents === null
          ? isNull(storeOrders.platformProfitCents)
          : eq(storeOrders.platformProfitCents, input.ledger.platformProfitCents),
      ),
    )
    .returning({ id: storeOrders.id });
  if (unchanged) return input.finalStatus;
  const [review] = await tx
    .update(storeOrders)
    .set({
      ...recordFee,
      feeReconcileStatus: "manual_review",
      feeReconcileAttempts: input.attemptNo,
      feeReconcileLastError: LOCKED_EARNING_FEE_MESSAGE,
      updatedAt: input.now,
    })
    .where(base)
    .returning({ id: storeOrders.id });
  return review ? "manual_review" : undefined;
}
