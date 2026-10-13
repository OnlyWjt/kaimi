import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { resendDeliveryMail } from "@/lib/mail";
import { enforceRateLimitFor } from "@/lib/rate-limit";

const MAIL_STATUS_TEXT: Record<string, string> = {
  sent: "发货邮件已重新发出",
  skipped: "没有发出：平台没开订单邮件，或你在「通知」里关了发货邮件",
  failed: "发送失败，系统稍后会自动重试",
};

/** 买家说没收到邮件时，代理在订单页点一下重发。同一单 2 分钟内只能点一次。 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const { orderNo } = await context.params;
  const order = await db.query.storeOrders.findFirst({
    where: and(eq(storeOrders.orderNo, orderNo), eq(storeOrders.agentId, session.agentId)),
    columns: { id: true },
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  const limited = enforceRateLimitFor(`agent-resend-mail:${order.id}`, 1, 2 * 60_000);
  if (limited) return limited;
  try {
    const result = await resendDeliveryMail(order.id);
    await writeAuditLog({
      actor: session,
      action: "agent.store_order.resend_mail",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo, status: result?.deliveryMailStatus ?? "" },
    });
    const status = result?.deliveryMailStatus || "";
    return NextResponse.json({
      ok: status === "sent",
      status,
      message: MAIL_STATUS_TEXT[status] || "已提交重发",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "重发失败" },
      { status: 400 },
    );
  }
}
