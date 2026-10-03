import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listDrawBills } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const params = new URL(req.url).searchParams;
  const result = await listDrawBills(
    {
      agentId: Number(params.get("billAgentId") || params.get("agentId") || 0),
      query: params.get("q") || "",
      paymentMethod: params.get("method") || "",
      status: params.get("billStatus") || "",
      from: params.get("from") || "",
      to: params.get("to") || "",
    },
    { page: params.get("page"), pageSize: params.get("pageSize") },
  );
  return NextResponse.json(result);
}
