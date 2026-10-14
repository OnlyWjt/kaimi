import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { positiveId, referralFail } from "@/lib/referral-route";
import { revokeReferralCoupon } from "@/lib/referrals";

const schema = z.object({ reason: z.string().trim().min(1, "请填写停用原因").max(200) });

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAgent();
    await bootDb();
    const couponId = positiveId((await context.params).id);
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!couponId || !parsed.success) {
      return NextResponse.json({ error: parsed.error?.issues[0]?.message || "参数无效" }, { status: 400 });
    }
    await revokeReferralCoupon({ couponId, reason: parsed.data.reason, agentId: session.agentId }, session);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return referralFail(error, "停用失败");
  }
}
