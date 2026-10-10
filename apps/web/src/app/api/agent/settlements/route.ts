import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentSettlements } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

/**
 * 只给「历史周结（旧）」用。对账批次登记付款时会往 agent_settlements 写一条镜像行，
 * 它的 settlement_no 等于批次的 batch_no；这些行已在对账批次里展示，这里排除，避免重复和
 * 负数批次被当成「已返佣 ¥0.00」。
 */
export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db
    .select()
    .from(agentSettlements)
    .where(
      and(
        eq(agentSettlements.agentId, session.agentId),
        sql`NOT EXISTS (SELECT 1 FROM agent_reconciliation_batches b WHERE b.batch_no = ${agentSettlements.settlementNo})`,
      ),
    )
    .orderBy(desc(agentSettlements.id))
    .limit(200);
  return NextResponse.json({ list });
}
