import { NextResponse } from "next/server";
import { and, desc, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { redeemGuardEvents } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { listRedeemBlocks, releaseRedeemBlock } from "@/lib/redeem-guard";
import { clientIp } from "@/lib/rate-limit";

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const failures = await db
    .select({
      subject: redeemGuardEvents.subject,
      subjectType: redeemGuardEvents.subjectType,
      count: sql<number>`count(*)`,
    })
    .from(redeemGuardEvents)
    .where(
      and(
        gte(redeemGuardEvents.createdAt, since),
        sql`${redeemGuardEvents.outcome} != 'ok'`,
      ),
    )
    .groupBy(redeemGuardEvents.subjectType, redeemGuardEvents.subject)
    .orderBy(desc(sql`count(*)`))
    .limit(50);
  return NextResponse.json({
    blocks: await listRedeemBlocks(),
    failures,
  });
}

export async function DELETE(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  const id = Number(new URL(req.url).searchParams.get("id") || 0);
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  await releaseRedeemBlock(id, clientIp(req));
  return NextResponse.json({ ok: true });
}
