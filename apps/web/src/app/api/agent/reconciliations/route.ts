import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { agentBatchView, listAgentBatches } from "@/lib/reconciliation";
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
  const query = new URL(req.url).searchParams;
  const cursor = Math.max(0, Number(query.get("cursor") || 0));
  const limit = Math.max(1, Math.min(100, Number(query.get("limit") || 20)));
  try {
    const page = await listAgentBatches(session.agentId, cursor, limit);
    return reconciliationData({ ...page, list: page.list.map(agentBatchView) }, requestId);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
