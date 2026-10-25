import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { agentVoidDrawItem, DrawError, revealDrawItemCode } from "@/lib/agent-draw";
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

/** 代理自己作废一张提的卡：{ action: "void", reason } */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAgent();
    await bootDb();
    const { id } = await context.params;
    const itemId = Number(id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return NextResponse.json({ error: "卡密不存在" }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as { action?: unknown; reason?: unknown };
    if (body.action !== "void") return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
    const result = await agentVoidDrawItem(
      { itemId, reason: typeof body.reason === "string" ? body.reason : "" },
      session,
      session.agentId,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof DrawError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof DrawError ? error.message : "作废失败，请稍后再试或联系平台" },
      { status },
    );
  }
}
