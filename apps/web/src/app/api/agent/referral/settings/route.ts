import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { referralFail } from "@/lib/referral-route";
import { getReferralSettings, saveReferralSettings } from "@/lib/referrals";

export async function GET() {
  try {
    const session = await requireAgent();
    await bootDb();
    return NextResponse.json(await getReferralSettings(session.agentId));
  } catch (error) {
    return referralFail(error, "加载失败");
  }
}

const schema = z.object({
  enabled: z.boolean(),
  couponValidDays: z.number().int(),
  coolingDays: z.number().int(),
  minOrderCents: z.number().int(),
  monthlyCap: z.number().int(),
  rewards: z
    .array(z.object({ planKey: z.string().trim().min(1).max(64), amountCents: z.number().int().nullable() }))
    .max(200),
});

export async function PUT(req: Request) {
  try {
    const session = await requireAgent();
    await bootDb();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
    return NextResponse.json(await saveReferralSettings(session.agentId, parsed.data, session));
  } catch (error) {
    return referralFail(error, "保存失败");
  }
}
