import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { agentEarnings, agents, storeOrders } from "@/db/schema";
import { createAgentSettlement } from "@/lib/agent-settlement";
import { beijingWeekBounds, previousCompletedWeekYmd } from "@/lib/beijing-week";
import { getSetting, setSetting } from "@/lib/config";

const CLOSED_KEY = "weekly_settlement_closed";

export async function closeBeijingWeek(mondayYmd: string, createdBy = 0) {
  const bounds = beijingWeekBounds(mondayYmd);
  const agentRows = await db.select({ id: agents.id }).from(agents);
  const created: string[] = [];
  const skipped: string[] = [];
  const held: string[] = [];
  const failed: string[] = [];
  for (const agent of agentRows) {
    try {
      const result = await createAgentSettlement({
        agentId: agent.id,
        periodStart: bounds.start,
        periodEnd: bounds.end,
        notes: `自动周结 ${bounds.mondayYmd} ～ ${bounds.sundayYmd}`,
        createdBy,
        lenient: true,
      });
      if (result.settlement && result.reason !== "already" && result.reason !== "empty" && result.reason !== "non_positive") {
        created.push(result.settlement.settlementNo);
      }
      held.push(...result.skippedManualReview, ...result.skippedMismatch);
      if (result.reason === "empty" || result.reason === "non_positive" || result.reason === "already") {
        skipped.push(String(agent.id));
      }
    } catch (error) {
      failed.push(`${agent.id}: ${error instanceof Error ? error.message : "结算失败"}`);
    }
  }
  return { week: bounds, created, skippedCount: skipped.length, held, failed };
}

export async function closePreviousWeekIfDue(now = new Date()) {
  const week = previousCompletedWeekYmd(now);
  const closed = await getSetting(CLOSED_KEY, "");
  if (closed >= week) return { week, already: true as const, created: [] as string[], held: [] as string[], failed: [] as string[], closed: true };
  const result = await closeBeijingWeek(week, 0);
  if (result.failed.length === 0) await setSetting(CLOSED_KEY, week);
  return {
    week,
    already: false as const,
    created: result.created,
    held: result.held,
    failed: result.failed,
    closed: result.failed.length === 0,
  };
}

export async function listWeekHeld(mondayYmd: string) {
  const bounds = beijingWeekBounds(mondayYmd);
  const rows = await db
    .select({
      orderNo: storeOrders.orderNo,
      agentName: agents.displayName,
      feeStatus: storeOrders.feeReconcileStatus,
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .innerJoin(agents, eq(agents.id, agentEarnings.agentId))
    .where(
      and(
        gte(agentEarnings.confirmedAt, bounds.start),
        lte(agentEarnings.confirmedAt, bounds.end),
        eq(storeOrders.payStatus, "paid"),
        eq(storeOrders.fulfillStatus, "delivered"),
        or(
          and(eq(agentEarnings.status, "pending"), isNull(agentEarnings.settlementId)),
          eq(storeOrders.feeReconcileStatus, "manual_review"),
        ),
      ),
    );
  return rows.map((row) => ({
    orderNo: row.orderNo,
    agentName: row.agentName,
    reason: row.feeStatus === "manual_review" ? "手续费待核对" : "还没进入结算单",
  }));
}
