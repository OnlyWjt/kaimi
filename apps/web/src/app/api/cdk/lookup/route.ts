import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, platformPlans } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { maskCode } from "@/lib/crypto";
import { findCdkByCode, releaseLockedCode, markCodeUsed } from "@/lib/inventory";
import { pollRechargeIfNeeded } from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isTerminalStatus } from "@/lib/recharge-types";
import { publicStatusLabel } from "@/lib/status-labels";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";

/** 客户认的是「Plus」这种套餐名，不是 pro_5x 这种内部套餐码。 */
async function planDisplayName(planKey: string) {
  if (!planKey) return "";
  const plan = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.planKey, planKey),
  });
  return plan?.name || planKey;
}

export async function GET(req: Request) {
  const limited = enforceRateLimit(req, "cdk-lookup", 30);
  if (limited) return limited;
  await bootDb();
  const code = new URL(req.url).searchParams.get("code")?.trim() || "";
  if (!code || code.length < 6) {
    return NextResponse.json({ error: "请输入完整卡密" }, { status: 400 });
  }

  const issued = await findIssuedCdkByCode(code);
  if (issued) {
    let orderNo: string | null = null;
    let message = "";
    let fulfillStatus: string | null = null;
    if (issued.redemptionOrderId) {
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, issued.redemptionOrderId),
      });
      if (order?.orderNo && !isTerminalStatus(order.fulfillStatus)) {
        await pollRechargeIfNeeded(order.orderNo).catch(() => null);
      }
      const fresh = order
        ? await db.query.orders.findFirst({ where: eq(orders.id, issued.redemptionOrderId) })
        : null;
      orderNo = fresh?.orderNo ?? order?.orderNo ?? null;
      message = fresh?.message || order?.message || "";
      fulfillStatus = fresh?.fulfillStatus ?? order?.fulfillStatus ?? null;
    }
    return NextResponse.json({
      found: true,
      codeMasked: maskCode(issued.code),
      status: publicStatusLabel(issued.status, "cdk"),
      planName: await planDisplayName(issued.planKey),
      orderNo,
      fulfillStatus: fulfillStatus
        ? publicStatusLabel(fulfillStatus, "fulfill")
        : null,
      message,
    });
  }

  let row = await findCdkByCode(code);

  if (!row) {
    return NextResponse.json({ found: false });
  }

  let orderNo: string | null = null;
  let message = "";
  let fulfillStatus: string | null = null;

  if (row.orderId) {
    let order = await db.query.orders.findFirst({
      where: eq(orders.id, row.orderId),
    });

    // 占用中时主动轮询上游，避免 webhook 丢失导致一直 locked
    if (order?.orderNo && row.status === "locked" && !isTerminalStatus(order.fulfillStatus)) {
      order = (await pollRechargeIfNeeded(order.orderNo).catch(() => order)) ?? order;
    }

    // 订单已终态但卡密仍 locked：当场对账解锁/核销
    if (order && row.status === "locked") {
      if (order.fulfillStatus === "success" || order.fulfillStatus === "skipped") {
        await markCodeUsed(row.code);
        row = (await findCdkByCode(code)) ?? row;
      } else if (order.fulfillStatus === "failed" || order.fulfillStatus === "unknown") {
        await releaseLockedCode(row.code);
        row = (await findCdkByCode(code)) ?? row;
      }
    }

    orderNo = order?.orderNo ?? null;
    message = order?.message || "";
    fulfillStatus = order?.fulfillStatus ?? null;
  }

  return NextResponse.json({
    found: true,
    codeMasked: maskCode(row.code),
    status: publicStatusLabel(row.status, "cdk"),
    planName: await planDisplayName(row.planKey),
    orderNo,
    fulfillStatus: fulfillStatus
      ? publicStatusLabel(fulfillStatus, "fulfill")
      : null,
    message,
  });
}
