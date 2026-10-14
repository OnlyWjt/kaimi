import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { positiveId, referralFail } from "@/lib/referral-route";
import { getReferralInviter } from "@/lib/referrals";

export async function GET(
  _req: Request,
  context: { params: Promise<{ agentId: string; codeId: string }> },
) {
  try {
    await requireAdmin();
    await bootDb();
    const params = await context.params;
    const agentId = positiveId(params.agentId);
    const codeId = positiveId(params.codeId);
    if (!agentId || !codeId) return NextResponse.json({ error: "邀请人不存在" }, { status: 404 });
    return NextResponse.json(await getReferralInviter(agentId, codeId));
  } catch (error) {
    return referralFail(error, "加载失败");
  }
}
