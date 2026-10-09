import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdmin } from "@/lib/admin-guard";
import { createCodeOrder } from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isShopEnabled } from "@/lib/storefront";

const schema = z.object({
  productId: z.number().int().positive(),
  email: z.string().email(),
  quantity: z.number().int().min(1).max(10).optional(),
});

/** 内部发卡接口：仅保留作管理员调试用，未登录 401、非管理员 403。 */
export async function POST(req: Request) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  const limited = enforceRateLimit(req, "shop-orders", 10);
  if (limited) return limited;
  if (!(await isShopEnabled())) {
    return NextResponse.json({ error: "内部发卡网已关闭，请从外链购买卡密" }, { status: 403 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  try {
    const body = parsed.data;
    const order = await createCodeOrder(body);
    return NextResponse.json({
      orderNo: order.orderNo,
      payStatus: order.payStatus,
      fulfillStatus: order.fulfillStatus,
      codes:
        order.payStatus === "paid" || order.payStatus === "manual"
          ? JSON.parse(order.deliveredCodesJson || "[]")
          : [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "下单失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
