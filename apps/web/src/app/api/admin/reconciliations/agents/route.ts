import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { isIsoUtc } from "@/lib/reconciliation-core";
import { ReconciliationError, listReconciliationAgents } from "@/lib/reconciliation";
import { newRequestId, reconciliationData, reconciliationFail } from "@/lib/reconciliation-http";

export async function GET(req: Request) {
  const requestId = newRequestId();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    return reconciliationFail(error, requestId);
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  const cutoffAt = query.get("cutoffAt")?.trim() || new Date().toISOString();
  if (!isIsoUtc(cutoffAt)) {
    return reconciliationFail(new ReconciliationError("INVALID_STATE", "cutoffAt 要用 UTC 时间", 422), requestId);
  }
  try {
    const data = await listReconciliationAgents({
      search: query.get("search")?.trim() || "",
      status: query.get("status")?.trim() || "",
      sort: query.get("sort")?.trim() || "net",
      cursor: query.get("cursor")?.trim() || "",
      limit: Math.max(1, Math.min(100, Number(query.get("limit") || 50))),
      cutoffAt,
    });
    return reconciliationData(data, requestId);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
