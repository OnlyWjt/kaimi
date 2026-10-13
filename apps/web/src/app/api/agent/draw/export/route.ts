import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { agentDrawExportRows, DrawError } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";
import { buildDrawWorkbook } from "@/lib/draw-export";

/** 按北京时间日期区间导出提过的卡密和成品号：?from=2026-10-01&to=2026-10-13 */
export async function GET(req: Request) {
  try {
    const session = await requireAgent();
    await bootDb();
    const params = new URL(req.url).searchParams;
    const from = params.get("from") || "";
    const to = params.get("to") || "";
    const rows = await agentDrawExportRows(session.agentId, { from, to }, session);
    const buffer = await buildDrawWorkbook(rows);
    const span = `${from.replace(/-/g, "")}-${to.replace(/-/g, "")}`;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="kaimi-draw-${span}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof DrawError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "导出失败" },
      { status },
    );
  }
}
