import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { DrawError, getAgentBill } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET(_req: Request, context: { params: Promise<{ billNo: string }> }) {
  try {
    const session = await requireAgent();
    await bootDb();
    const { billNo } = await context.params;
    const bill = await getAgentBill(session.agentId, decodeURIComponent(billNo));
    return NextResponse.json(bill);
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof DrawError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "加载失败" },
      { status },
    );
  }
}
