import { NextResponse } from "next/server";
import { z } from "zod";
import { createCodeOrder } from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isShopEnabled } from "@/lib/storefront";

const schema = z.object({
  productId: z.number().int().positive(),
  email: z.string().email(),
  quantity: z.number().int().min(1).max(10).optional(),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "shop-orders", 10);
  if (limited) return limited;
  if (!(await isShopEnabled())) {
    return NextResponse.json({ error: "内部发卡网已关闭，请从外链购买卡密" }, { status: 403 });
  }
  try {
    const body = schema.parse(await req.json());
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
