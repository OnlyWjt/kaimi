import { NextResponse } from "next/server";
import { listAgentConsolePlans } from "@/lib/agent-console";
import { requireAgent } from "@/lib/auth";

export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  return NextResponse.json({ list: await listAgentConsolePlans(session.agentId) });
}
