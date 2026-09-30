import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { listAgentBills } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET() {
  try {
    const session = await requireAgent();
    await bootDb();
    const bills = await listAgentBills(session.agentId);
    return NextResponse.json({ bills });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
