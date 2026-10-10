import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { agentBatchView, getReconciliation, ReconciliationError } from "@/lib/reconciliation";
import { newRequestId, reconciliationData, reconciliationFail } from "@/lib/reconciliation-http";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
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
  const found = await getReconciliation(id, session.agentId);
  if (!found) return reconciliationFail(new ReconciliationError("INVALID_STATE", "批次不存在", 404), requestId);
  return reconciliationData(agentBatchView(found.batch), requestId);
}
