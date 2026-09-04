import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { cdkPool, orders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { getStatusHistory, pollRechargeIfNeeded } from "@/lib/orders";
import { getOrderTimelines, getUpstreamSnapshots } from "@/lib/order-timeline";
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

  // 只报邮箱就把明文卡密发出去，等于知道买家邮箱就能把他的卡偷走。订单号是 10 位
  // 随机串（32 进制，约 50 bit），拿得出订单号才算证明了这一单是自己的。
  // 按邮箱查只回打码的卡密，够买家确认「我这一单出卡了」。
  const fullCodesAllowed = Boolean(orderNo);

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

  // 时间线和订单级快照一次批量取回，别在 map 里逐单查。
  const orderIds = list.map((o) => o.id);
  const [timelines, snapshots] = await Promise.all([
    getOrderTimelines(orderIds),
    getUpstreamSnapshots(orderIds),
  ]);

  const mapped = await Promise.all(
    list.map(async (o) => {
      const history = await getStatusHistory(o.id);
      const rawCode = codeByOrder.get(o.id) || "";
      const snapshot = snapshots.get(o.id);
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
        // 卡台侧的订单级字段。原始报文只在管理端出现，买家看不到。
        upstreamStatus: snapshot?.status || "",
        upstreamStage: snapshot?.stage || "",
        cardLastFour: snapshot?.cardLastFour || "",
        timeline: timelines.get(o.id) || [],
        history: history.map((h) => ({
          status: h.status,
          message: h.message,
          at: h.createdAt,
          source: h.source,
        })),
        codes:
          fullCodesAllowed &&
          o.kind === "code" &&
          (o.payStatus === "paid" || o.payStatus === "manual")
            ? (JSON.parse(o.deliveredCodesJson || "[]") as string[])
            : [],
        /** 明文卡密被藏起来了，界面要据此提示买家改用订单号查。 */
        codesMasked: !fullCodesAllowed,
        codeHints:
          o.kind === "code"
            ? (JSON.parse(o.deliveredCodesJson || "[]") as string[]).map(maskCode)
            : [],
      };
    }),
  );

  return NextResponse.json({ list: mapped });
}
