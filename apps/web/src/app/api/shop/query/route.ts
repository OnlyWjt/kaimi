import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { cdkPool, orders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { getStatusHistory, pollRechargeIfNeeded } from "@/lib/orders";
import { maskCode } from "@/lib/crypto";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const limited = enforceRateLimit(req, "shop-query", 30);
  if (limited) return limited;
  await bootDb();
  const { searchParams } = new URL(req.url);
  const orderNo = searchParams.get("orderNo")?.trim() || "";
  const email = searchParams.get("email")?.trim().toLowerCase() || "";

  if (!orderNo && !email) {
    return NextResponse.json({ error: "请提供订单号或邮箱" }, { status: 400 });
  }

  if (orderNo) {
    await pollRechargeIfNeeded(orderNo).catch(() => null);
  }

  const list = await db.query.orders.findMany({
    where: and(
      orderNo ? eq(orders.orderNo, orderNo) : undefined,
      email ? eq(orders.email, email) : undefined,
    ),
    limit: 20,
  });

  const cdkRows = list.length
    ? await db
        .select({ orderId: cdkPool.orderId, code: cdkPool.code })
        .from(cdkPool)
        .where(
          inArray(
            cdkPool.orderId,
            list.map((o) => o.id),
          ),
        )
    : [];
  const codeByOrder = new Map<number, string>();
  for (const row of cdkRows) {
    if (row.orderId) codeByOrder.set(row.orderId, row.code);
  }

  const mapped = await Promise.all(
    list.map(async (o) => {
      const history = await getStatusHistory(o.id);
      const rawCode = codeByOrder.get(o.id) || "";
      return {
        orderNo: o.orderNo,
        kind: o.kind,
        email: o.accountEmail || o.email || "",
        accountEmail: o.accountEmail || o.email || "",
        codeMasked: rawCode ? maskCode(rawCode) : "",
        codeLast4: rawCode ? rawCode.slice(-4) : "",
        payStatus: o.payStatus,
        fulfillStatus: o.fulfillStatus,
        message: o.message,
        createdAt: o.createdAt,
        history: history.map((h) => ({
          status: h.status,
          message: h.message,
          at: h.createdAt,
          source: h.source,
        })),
        codes:
          o.kind === "code" && (o.payStatus === "paid" || o.payStatus === "manual")
            ? (JSON.parse(o.deliveredCodesJson || "[]") as string[])
            : [],
        codeHints:
          o.kind === "code"
            ? (JSON.parse(o.deliveredCodesJson || "[]") as string[]).map(maskCode)
            : [],
      };
    }),
  );

  return NextResponse.json({ list: mapped });
}
