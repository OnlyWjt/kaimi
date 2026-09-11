import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { setCouponEnabled } from "@/lib/coupons";

const schema = z.object({
  enabled: z.boolean(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const couponId = Number((await context.params).id);
  if (!Number.isSafeInteger(couponId) || couponId < 1) {
    return NextResponse.json({ error: "优惠券不存在" }, { status: 404 });
  }
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "参数无效" }, { status: 400 });
  }
  try {
    await setCouponEnabled(couponId, parsed.data.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败" },
      { status: 400 },
    );
  }
}
