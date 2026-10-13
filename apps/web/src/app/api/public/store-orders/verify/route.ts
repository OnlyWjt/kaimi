import { NextResponse } from "next/server";
import { z } from "zod";
import { bootDb } from "@/lib/config";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyStoreOrderOwnership } from "@/lib/store-orders";

const schema = z.object({
  slug: z.string().trim().min(3).max(32),
  email: z.string().trim().email("请填写有效邮箱").max(254),
  orderNo: z.string().trim().min(6, "请填写完整订单号").max(40),
});

/** 按邮箱查到订单后，买家输入完整订单号，换取查看卡密的凭证。 */
export async function POST(req: Request) {
  // 比查单更紧：这是在猜订单号，每个 IP 每分钟 10 次足够正常人用。
  const limited = enforceRateLimit(req, "public-store-order-verify", 10);
  if (limited) return limited;
  await bootDb();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }
  const result = await verifyStoreOrderOwnership(parsed.data);
  if (!result) {
    return NextResponse.json(
      { error: "订单号和邮箱对不上，请核对付款记录或发货邮件里的订单号" },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
