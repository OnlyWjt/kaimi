import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { listAgentBatches, ReconciliationError } from "@/lib/reconciliation";
import { newRequestId, reconciliationData, reconciliationFail } from "@/lib/reconciliation-http";

/** 管理员按代理列出全部批次（新到旧），cursor 是偏移量，limit 最多 100。 */
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
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return reconciliationFail(new ReconciliationError("INVALID_STATE", "代理无效", 422), requestId);
  }
  const query = new URL(req.url).searchParams;
  const cursor = Math.max(0, Math.floor(Number(query.get("cursor") || 0)) || 0);
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.get("limit") || 50)) || 50));
  try {
    return reconciliationData(await listAgentBatches(agentId, cursor, limit), requestId);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
