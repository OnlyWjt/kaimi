import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { setCouponEnabled, updateAgentCoupon } from "@/lib/coupons";

async function authorize() {
  try {
    return { session: await requireAgent(), error: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, error };
    throw error;
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { session, error } = await authorize();
  if (!session) return error;
  await bootDb();
  const couponId = Number((await context.params).id);
  if (!Number.isSafeInteger(couponId) || couponId < 1) {
    return NextResponse.json({ error: "优惠券不存在" }, { status: 404 });
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (body.enabled !== undefined && Object.keys(body).length === 1) {
      await setCouponEnabled(couponId, Boolean(body.enabled), session.agentId);
      return NextResponse.json({ ok: true });
    }
    const coupon = await updateAgentCoupon(session.agentId, couponId, body);
    return NextResponse.json({ coupon });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : "保存失败" },
      { status: 400 },
    );
  }
}
