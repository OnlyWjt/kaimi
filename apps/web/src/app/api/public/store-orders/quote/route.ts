import { NextResponse } from "next/server";
import { z } from "zod";
import { bootDb } from "@/lib/config";
import { enforceRateLimit } from "@/lib/rate-limit";
import { HARD_MAX_ORDER_QUANTITY } from "@/lib/store-quantity-core";
import { quoteStoreCheckout } from "@/lib/store-orders";

const schema = z.object({
  slug: z.string().trim().min(3).max(32),
  planKey: z.string().trim().min(1).max(64),
  channel: z.enum(["alipay", "wxpay"]),
  quantity: z
    .number()
    .int("购买数量要是整数")
    .min(1, "购买数量至少 1 张")
    .max(HARD_MAX_ORDER_QUANTITY, "购买数量超出上限")
    .optional(),
  couponCode: z.string().trim().max(20).optional(),
  invoiceRequested: z.boolean().optional(),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-store-order-quote", 20);
  if (limited) return limited;
  await bootDb();
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "询价参数无效" },
      { status: 400 },
    );
  }
  try {
    const quote = await quoteStoreCheckout(parsed.data);
    return NextResponse.json(quote);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "询价失败" },
      { status: 400 },
    );
  }
}
