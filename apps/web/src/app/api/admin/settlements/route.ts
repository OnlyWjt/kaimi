import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentSettlements, users } from "@/db/schema";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { requireAdmin } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { bootDb } from "@/lib/config";

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

export async function POST(_req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  void session;
  await bootDb();
  return NextResponse.json(
    { error: "旧的按周期生成结算单已关闭。请到「对账」按代理结清商店收益和提卡。" },
    { status: 409 },
  );
}
