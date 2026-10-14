import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { pageQuery, positiveId, referralFail } from "@/lib/referral-route";
import { listReferralInviters } from "@/lib/referrals";

export async function GET(req: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    await requireAdmin();
    await bootDb();
    const agentId = positiveId((await context.params).agentId);
    if (!agentId) return NextResponse.json({ error: "代理不存在" }, { status: 404 });
    return NextResponse.json(await listReferralInviters(agentId, pageQuery(req)));
  } catch (error) {
    return referralFail(error, "加载失败");
  }
}
