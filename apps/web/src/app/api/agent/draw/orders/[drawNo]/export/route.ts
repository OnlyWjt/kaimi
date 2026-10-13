import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { agentDrawExportRows, DrawError } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";
import { buildDrawWorkbook } from "@/lib/draw-export";

/** 一张提取单的卡密 / 成品号导出 Excel。 */
export async function GET(_req: Request, context: { params: Promise<{ drawNo: string }> }) {
  try {
    const session = await requireAgent();
    await bootDb();
    const drawNo = decodeURIComponent((await context.params).drawNo);
    const rows = await agentDrawExportRows(session.agentId, { drawNo }, session);
    const buffer = await buildDrawWorkbook(rows);
    const safeNo = drawNo.replace(/[^A-Za-z0-9_-]/g, "");
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="kaimi-draw-${safeNo}.xlsx"`,
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
