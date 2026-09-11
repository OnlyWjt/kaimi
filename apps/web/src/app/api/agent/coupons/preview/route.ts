import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { previewAgentCoupon } from "@/lib/coupons";

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  try {
    const preview = await previewAgentCoupon(
      session.agentId,
      (await req.json()) as Record<string, unknown>,
    );
    return NextResponse.json(preview);
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : "预览失败" },
      { status: 400 },
    );
  }
}
