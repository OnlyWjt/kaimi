import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, agentSettlements, users } from "@/db/schema";
import { createAgentSettlement } from "@/lib/agent-settlement";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { requireAdmin } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { bootDb } from "@/lib/config";
import { periodBoundary } from "@/lib/period";

const createSchema = z.object({
  agentId: z.number().int().positive(),
  periodStart: z.string().trim().min(10).max(40),
  periodEnd: z.string().trim().min(10).max(40),
  notes: z.string().trim().max(500).optional().default(""),
});

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db
    .select({
      id: agentSettlements.id,
      settlementNo: agentSettlements.settlementNo,
      agentId: agentSettlements.agentId,
      agentName: agents.displayName,
      realName: agents.realName,
      shopName: agents.shopName,
      settlementName: agents.settlementName,
      settlementMethod: agents.settlementMethod,
      settlementAccountEncrypted: agents.settlementAccountEncrypted,
      username: users.username,
      periodStart: agentSettlements.periodStart,
      periodEnd: agentSettlements.periodEnd,
      amountCents: agentSettlements.amountCents,
      status: agentSettlements.status,
      paymentMethod: agentSettlements.paymentMethod,
      paymentReference: agentSettlements.paymentReference,
      createdAt: agentSettlements.createdAt,
      paidAt: agentSettlements.paidAt,
    })
    .from(agentSettlements)
    .innerJoin(agents, eq(agents.id, agentSettlements.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .orderBy(desc(agentSettlements.id))
    .limit(200);
  return NextResponse.json({
    list: list.map((row) => {
      let settlementAccount = "";
      if (row.settlementAccountEncrypted) {
        try {
          settlementAccount = decryptSecret(row.settlementAccountEncrypted);
        } catch {
          settlementAccount = "";
        }
      }
      return {
        id: row.id,
        settlementNo: row.settlementNo,
        agentId: row.agentId,
        agentName: agentIdentityLabel({
          agentId: row.agentId,
          displayName: row.agentName,
          realName: row.realName,
          shopName: row.shopName,
          settlementName: row.settlementName,
          username: row.username,
        }),
        settlementPayee: row.settlementName,
        settlementMethod: row.settlementMethod,
        settlementAccount,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        amountCents: row.amountCents,
        status: row.status,
        paymentMethod: row.paymentMethod,
        paymentReference: row.paymentReference,
        createdAt: row.createdAt,
        paidAt: row.paidAt,
      };
    }),
  });
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  let periodStart: string;
  let periodEnd: string;
  try {
    periodStart = periodBoundary(data.periodStart, false);
    periodEnd = periodBoundary(data.periodEnd, true);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结算周期格式无效" },
      { status: 400 },
    );
  }
  if (periodStart > periodEnd) {
    return NextResponse.json({ error: "结算开始时间不能晚于结束时间" }, { status: 400 });
  }

  try {
  const result = await createAgentSettlement({
    agentId: data.agentId,
    periodStart,
    periodEnd,
    notes: data.notes,
    createdBy: session.id,
    actor: session,
  });
  if (!result.settlement) {
    return NextResponse.json({ error: "该时间范围没有待结算收益。" }, { status: 409 });
  }
  return NextResponse.json({
    settlement: result.settlement,
    skippedManualReview: result.skippedManualReview,
  });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结算单创建失败" },
      { status: 409 },
    );
  }
}
