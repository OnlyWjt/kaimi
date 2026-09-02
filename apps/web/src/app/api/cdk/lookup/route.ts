import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cdkPool, orders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { maskCode } from "@/lib/crypto";
import { findCdkByCode, releaseLockedCode, markCodeUsed } from "@/lib/inventory";
import { pollRechargeIfNeeded } from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isTerminalStatus } from "@/lib/recharge-types";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";

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
    const issuedLabel: Record<string, string> = {
      unused: "未使用",
      locked: "占用中",
      redeeming: "兑换中",
      used: "已核销/已使用",
      disabled: "已禁用",
    };
    return NextResponse.json({
      found: true,
      codeMasked: maskCode(issued.code),
      status: issuedLabel[issued.status] || issued.status,
      planKey: issued.planKey,
      orderNo,
      fulfillStatus,
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

  const statusLabel: Record<string, string> = {
    unused: "未使用",
    locked: "占用中",
    sold: "已售出",
    used: "已核销/已使用",
    disabled: "已禁用",
  };

  return NextResponse.json({
    found: true,
    codeMasked: maskCode(row.code),
    status: statusLabel[row.status] || row.status,
    planKey: row.planKey,
    orderNo,
    fulfillStatus,
    message,
  });
}
