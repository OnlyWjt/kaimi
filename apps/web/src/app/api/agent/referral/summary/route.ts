import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { referralFail } from "@/lib/referral-route";
import { referralSummary } from "@/lib/referrals";

export async function GET() {
  try {
    const session = await requireAgent();
    await bootDb();
    const [month, total] = await Promise.all([
      referralSummary(session.agentId, "month"),
      referralSummary(session.agentId, "all"),
    ]);
    return NextResponse.json({ month, total });
  } catch (error) {
    return referralFail(error, "加载失败");
  }
}
