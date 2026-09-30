import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { listAgentUnsettledItems } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET() {
  try {
    const session = await requireAgent();
    await bootDb();
    const items = await listAgentUnsettledItems(session.agentId);
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
