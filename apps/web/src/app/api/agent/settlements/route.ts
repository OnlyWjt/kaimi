import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentSettlements } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db.query.agentSettlements.findMany({
    where: eq(agentSettlements.agentId, session.agentId),
    orderBy: [desc(agentSettlements.id)],
    limit: 200,
  });
  return NextResponse.json({ list });
}
