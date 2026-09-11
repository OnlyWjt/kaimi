import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { beijingDateRangeIso } from "@/lib/earnings-stats-core";
import { loadUsageStats } from "@/lib/usage-stats";

export async function GET(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const startYmd = query.get("start")?.trim() || today;
  const endYmd = query.get("end")?.trim() || today;
  try {
    const range = beijingDateRangeIso(startYmd, endYmd);
    const stats = await loadUsageStats({
      startIso: range.start,
      endIso: range.end,
      agentId: session.agentId,
    });
    return NextResponse.json({
      range: { start: startYmd, end: endYmd },
      ...stats,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "统计加载失败" },
      { status: 400 },
    );
  }
}
