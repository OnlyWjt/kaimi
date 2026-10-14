import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { referralFail } from "@/lib/referral-route";
import { adminReferralOverview } from "@/lib/referrals";

export async function GET() {
  try {
    await requireAdmin();
    await bootDb();
    return NextResponse.json(await adminReferralOverview());
  } catch (error) {
    return referralFail(error, "加载失败");
  }
}
