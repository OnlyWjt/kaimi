import { NextResponse } from "next/server";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, storeOrders } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret, maskCode } from "@/lib/crypto";

export async function GET(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  const page = Math.max(1, Number(query.get("page") || 1));
  const pageSize = Math.max(1, Math.min(100, Number(query.get("pageSize") || 20)));
  const q = query.get("q")?.trim() || "";
  const conditions = [eq(issuedCdks.agentId, session.agentId)];
  if (q) conditions.push(like(storeOrders.orderNo, `%${q}%`));
  const where = and(...conditions);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(issuedCdks)
    .innerJoin(storeOrders, eq(storeOrders.id, issuedCdks.orderId))
    .where(where);

  const rows = await db
    .select({
      id: issuedCdks.id,
      codeEncrypted: issuedCdks.codeEncrypted,
      planKey: issuedCdks.planKey,
      status: issuedCdks.status,
      issuedAt: issuedCdks.issuedAt,
      usedAt: issuedCdks.usedAt,
      orderNo: storeOrders.orderNo,
    })
    .from(issuedCdks)
    .innerJoin(storeOrders, eq(storeOrders.id, issuedCdks.orderId))
    .where(where)
    .orderBy(desc(issuedCdks.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return NextResponse.json({
    list: rows.map((row) => ({
      id: row.id,
      code: maskCode(decryptSecret(row.codeEncrypted)),
      planKey: row.planKey,
      status: row.status,
      orderNo: row.orderNo,
      issuedAt: row.issuedAt,
      usedAt: row.usedAt,
    })),
    page,
    pageSize,
    total: Number(total) || 0,
  });
}
