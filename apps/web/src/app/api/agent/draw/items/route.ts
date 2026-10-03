import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { listAgentUnsettledItems } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET(req: Request) {
  try {
    const session = await requireAgent();
    await bootDb();
    const params = new URL(req.url).searchParams;
    const result = await listAgentUnsettledItems(session.agentId, {
      page: params.get("page"),
      pageSize: params.get("pageSize"),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
