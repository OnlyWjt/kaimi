import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { DrawError, getAgentDrawOrderCodes } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET(_req: Request, context: { params: Promise<{ drawNo: string }> }) {
  try {
    const session = await requireAgent();
    await bootDb();
    const { drawNo } = await context.params;
    const order = await getAgentDrawOrderCodes(session.agentId, decodeURIComponent(drawNo), session);
    return NextResponse.json(order);
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof DrawError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "加载失败" },
      { status },
    );
  }
}
