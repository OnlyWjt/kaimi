import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { createAgentCoupon, listAgentCoupons } from "@/lib/coupons";

async function authorize() {
  try {
    return { session: await requireAgent(), error: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, error };
    throw error;
  }
}

export async function GET() {
  const { session, error } = await authorize();
  if (!session) return error;
  await bootDb();
  return NextResponse.json({ list: await listAgentCoupons(session.agentId) });
}

export async function POST(req: Request) {
  const { session, error } = await authorize();
  if (!session) return error;
  await bootDb();
  try {
    const coupon = await createAgentCoupon(
      session.agentId,
      (await req.json()) as Record<string, unknown>,
    );
    return NextResponse.json({ coupon });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : "创建失败" },
      { status: 400 },
    );
  }
}
