import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { positiveId, referralFail } from "@/lib/referral-route";
import { getReferralInviter } from "@/lib/referrals";

export async function GET(_req: Request, context: { params: Promise<{ codeId: string }> }) {
  try {
    const session = await requireAgent();
    await bootDb();
    const codeId = positiveId((await context.params).codeId);
    if (!codeId) return NextResponse.json({ error: "邀请人不存在" }, { status: 404 });
    return NextResponse.json(await getReferralInviter(session.agentId, codeId));
  } catch (error) {
    return referralFail(error, "加载失败");
  }
}
