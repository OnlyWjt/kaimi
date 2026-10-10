import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { previewReconciliation, ReconciliationError } from "@/lib/reconciliation";
import { newRequestId, reconciliationData, reconciliationFail } from "@/lib/reconciliation-http";

export async function GET(req: Request, context: { params: Promise<{ agentId: string }> }) {
  const requestId = newRequestId();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    return reconciliationFail(error, requestId);
  }
  await bootDb();
  const agentId = Number((await context.params).agentId);
  const cutoffAt = new URL(req.url).searchParams.get("cutoffAt")?.trim() || new Date().toISOString();
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return reconciliationFail(new ReconciliationError("INVALID_STATE", "代理无效", 422), requestId);
  }
  try {
    return reconciliationData(await previewReconciliation(agentId, cutoffAt), requestId);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
