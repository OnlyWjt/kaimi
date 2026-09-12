import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { syncDefaultCardplatformPlans } from "@/lib/cardplatform/plans";

export async function POST() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  try {
    const result = await syncDefaultCardplatformPlans();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "套餐同步失败" },
      { status: 502 },
    );
  }
}
