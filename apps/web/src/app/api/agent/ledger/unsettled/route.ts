import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { isIsoUtc } from "@/lib/reconciliation-core";
import { agentLedger, ReconciliationError } from "@/lib/reconciliation";
import { newRequestId, reconciliationData, reconciliationFail } from "@/lib/reconciliation-http";

export async function GET(req: Request) {
  const requestId = newRequestId();
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    return reconciliationFail(error, requestId);
  }
  await bootDb();
  const cutoffAt = new URL(req.url).searchParams.get("cutoffAt")?.trim() || new Date().toISOString();
  if (!isIsoUtc(cutoffAt)) {
    return reconciliationFail(new ReconciliationError("INVALID_STATE", "cutoffAt 要用 UTC 时间", 422), requestId);
  }
  try {
    return reconciliationData(await agentLedger(session.agentId, cutoffAt), requestId);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
