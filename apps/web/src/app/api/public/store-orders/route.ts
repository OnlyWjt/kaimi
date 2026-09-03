import { NextResponse } from "next/server";
import { z } from "zod";
import { bootDb } from "@/lib/config";
import { createStoreOrder } from "@/lib/store-orders";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  slug: z.string().trim().min(3).max(32),
  planKey: z.string().trim().min(1).max(64),
  channel: z.enum(["alipay", "wxpay"]),
  customerEmail: z.string().trim().email("请填写有效邮箱").max(254),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-store-order-create", 10);
  if (limited) return limited;
  await bootDb();
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "下单参数无效" },
      { status: 400 },
    );
  }
  try {
    const result = await createStoreOrder({ request: req, ...parsed.data });
    return NextResponse.json({
      orderNo: result.order.orderNo,
      queryToken: result.queryToken,
      payUrl: result.payUrl,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "下单失败" },
      { status: 400 },
    );
  }
}
