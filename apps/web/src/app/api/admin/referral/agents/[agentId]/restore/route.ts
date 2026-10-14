import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { positiveId, referralFail } from "@/lib/referral-route";
import { adminRestoreReferral } from "@/lib/referrals";

export async function POST(_req: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireAdmin();
    await bootDb();
    const agentId = positiveId((await context.params).agentId);
    if (!agentId) return NextResponse.json({ error: "代理不存在" }, { status: 404 });
    await adminRestoreReferral(agentId, session);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return referralFail(error, "恢复失败");
  }
}
