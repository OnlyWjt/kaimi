import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { beijingMondayYmd, previousCompletedWeekYmd } from "@/lib/beijing-week";
import { listWeekHeld } from "@/lib/weekly-settlement";

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const week = new URL(req.url).searchParams.get("week") || previousCompletedWeekYmd();
  if (week >= beijingMondayYmd()) return NextResponse.json({ week, held: [] });
  return NextResponse.json({ week, held: await listWeekHeld(week) });
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const body = await req.json().catch(() => ({}));
  const requested = typeof body.week === "string" ? body.week : "";
  const previous = previousCompletedWeekYmd();
  if (requested && requested >= beijingMondayYmd()) {
    return NextResponse.json({ error: "这一周还没结束，不能结算" }, { status: 400 });
  }
  void session;
  return NextResponse.json({
    disabled: true,
    created: [],
    failed: [],
    held: [],
    previous,
    message: "周结已关闭。未结账到「对账」里按代理生成批次。",
  });
}
