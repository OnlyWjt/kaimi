import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { pageQuery, referralFail } from "@/lib/referral-route";
import { listReferralInviters } from "@/lib/referrals";

export async function GET(req: Request) {
  try {
    const session = await requireAgent();
    await bootDb();
    return NextResponse.json(await listReferralInviters(session.agentId, pageQuery(req)));
  } catch (error) {
    return referralFail(error, "加载失败");
  }
}
