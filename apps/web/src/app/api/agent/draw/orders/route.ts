import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { listAgentDrawOrders } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET() {
  try {
    const session = await requireAgent();
    await bootDb();
    const orders = await listAgentDrawOrders(session.agentId);
    return NextResponse.json({ orders });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
