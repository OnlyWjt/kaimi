import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentDrawItems, agentDrawOrders, issuedCdks, storeOrders } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret, hashLookupValue, maskCode } from "@/lib/crypto";
import { isFinishedRef } from "@/lib/finished-account-core";

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
  // 店里卖出的和自己提的卡都列出来；提卡的卡没有店铺订单，挂在提卡单上。
  const conditions = [
    eq(issuedCdks.agentId, session.agentId),
    ne(issuedCdks.cardplatformAccountId, 0),
    or(isNotNull(storeOrders.id), isNotNull(agentDrawOrders.id)),
  ];
  // 订单号 / 提卡单号模糊匹配；整张卡密走哈希精确匹配，不存明文也能查。
  if (q) {
    const match = or(
      like(storeOrders.orderNo, `%${q}%`),
      like(agentDrawOrders.drawNo, `%${q}%`),
      eq(issuedCdks.codeHash, hashLookupValue(q.toUpperCase())),
    );
    if (match) conditions.push(match);
  }
  const where = and(...conditions);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(issuedCdks)
    .leftJoin(storeOrders, eq(storeOrders.id, issuedCdks.orderId))
    .leftJoin(agentDrawOrders, eq(agentDrawOrders.id, issuedCdks.drawOrderId))
    .where(where);

  const rows = await db
    .select({
      id: issuedCdks.id,
      codeEncrypted: issuedCdks.codeEncrypted,
      planKey: issuedCdks.planKey,
      paymentCountry: issuedCdks.paymentCountry,
      status: issuedCdks.status,
      issuedAt: issuedCdks.issuedAt,
      usedAt: issuedCdks.usedAt,
      orderNo: storeOrders.orderNo,
      drawNo: agentDrawOrders.drawNo,
      // 提卡的卡：对应的账本行，决定能不能自己作废、是不是已作废
      drawItemId: agentDrawItems.id,
      drawItemStatus: agentDrawItems.status,
      manualUsedAt: agentDrawItems.manualUsedAt,
      upstreamRef: issuedCdks.upstreamRef,
      inBatch: sql<number>`EXISTS (
        SELECT 1 FROM agent_reconciliation_claims
        WHERE agent_reconciliation_claims.source_type = 'draw_item'
          AND agent_reconciliation_claims.source_id = ${agentDrawItems.id}
          AND agent_reconciliation_claims.claim_state = 'active'
      )`,
    })
    .from(issuedCdks)
    .leftJoin(storeOrders, eq(storeOrders.id, issuedCdks.orderId))
    .leftJoin(agentDrawOrders, eq(agentDrawOrders.id, issuedCdks.drawOrderId))
    .leftJoin(agentDrawItems, eq(agentDrawItems.issuedCdkId, issuedCdks.id))
    .where(where)
    .orderBy(desc(issuedCdks.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return NextResponse.json({
    list: rows.map((row) => ({
      id: row.id,
      code: maskCode(decryptSecret(row.codeEncrypted)),
      planKey: row.planKey,
      paymentCountry: row.paymentCountry,
      status: row.status,
      orderNo: row.orderNo || row.drawNo || "",
      source: row.orderNo ? "shop" : "draw",
      drawItemId: row.drawItemId ?? null,
      voided: row.drawItemStatus === "void",
      /** 自己提的、没结算、没使用、不在对账里的卡密可以自己作废 */
      voidable:
        !row.orderNo &&
        row.drawItemStatus === "unsettled" &&
        row.status === "unused" &&
        !row.manualUsedAt &&
        !isFinishedRef(row.upstreamRef) &&
        !Number(row.inBatch),
      issuedAt: row.issuedAt,
      usedAt: row.usedAt,
    })),
    page,
    pageSize,
    total: Number(total) || 0,
  });
}
