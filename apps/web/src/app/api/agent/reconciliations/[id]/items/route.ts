import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { itemsCsv, listReconciliationItems, ReconciliationError } from "@/lib/reconciliation";
import { newRequestId, reconciliationData, reconciliationFail } from "@/lib/reconciliation-http";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    return reconciliationFail(error, requestId);
  }
  await bootDb();
  const id = Number((await context.params).id);
  const query = new URL(req.url).searchParams;
  const cursor = Math.max(0, Number(query.get("cursor") || 0));
  const limit = Math.max(1, Math.min(100, Number(query.get("limit") || 50)));
  const found = await listReconciliationItems(id, session.agentId, cursor, limit, query.get("type")?.trim() || "");
  if (!found) return reconciliationFail(new ReconciliationError("INVALID_STATE", "批次不存在", 404), requestId);
  if (query.get("format") === "csv") {
    return new Response(
      itemsCsv(
        found.batchNo,
        found.snapshotHash,
        found.items.map((item) => ({
          sourceOrderNo: item.sourceOrderNo,
          sourceType: item.sourceType,
          amountCents: item.amountCents,
          snapshotJson: item.snapshotJson,
        })),
      ),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${found.batchNo}.csv"`,
        },
      },
    );
  }
  return reconciliationData(found, requestId);
}
