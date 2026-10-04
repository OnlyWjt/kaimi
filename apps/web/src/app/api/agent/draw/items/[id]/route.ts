import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { DrawError, revealDrawItemCode } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAgent();
    await bootDb();
    const { id } = await context.params;
    const itemId = Number(id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return NextResponse.json({ error: "卡密不存在" }, { status: 404 });
    }
    return NextResponse.json(await revealDrawItemCode(itemId, session, session.agentId));
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof DrawError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查看失败" },
      { status },
    );
  }
}
