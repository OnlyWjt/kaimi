import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { drawLedgerCsv, type DrawBillQuery } from "@/lib/agent-draw";
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
  const kind = params.get("kind") === "bills" ? "bills" : "items";
  const agentId = Number(params.get("agentId") || params.get("billAgentId") || 0);
  const billQuery: DrawBillQuery = {
    agentId,
    query: params.get("q") || "",
    paymentMethod: params.get("method") || "",
    status: params.get("billStatus") || "",
  };
  const csv = await drawLedgerCsv(kind, agentId, billQuery);
  const filename = kind === "bills" ? "kaimi-draw-bills.csv" : "kaimi-draw-items.csv";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
