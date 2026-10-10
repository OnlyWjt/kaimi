import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { createReconciliation, ReconciliationError } from "@/lib/reconciliation";
import {
  clientIp,
  idempotencyKey,
  newRequestId,
  reconciliationData,
  reconciliationFail,
} from "@/lib/reconciliation-http";

const schema = z.object({
  agentId: z.number().int().positive(),
  cutoffAt: z.string(),
  previewVersion: z.string().min(8),
  items: z
    .array(
      z.object({
        type: z.enum(["earning", "adjustment", "draw_item"]),
        id: z.number().int().positive(),
        version: z.string().min(1),
      }),
    )
    .max(5000),
  acknowledgedSkipped: z.array(z.string()).default([]),
});

export async function POST(req: Request) {
  const requestId = newRequestId();
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    return reconciliationFail(error, requestId);
  }
  const key = idempotencyKey(req);
  if (!key) {
    return reconciliationFail(new ReconciliationError("INVALID_STATE", "缺少 Idempotency-Key", 422), requestId);
  }
  await bootDb();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return reconciliationFail(new ReconciliationError("INVALID_STATE", "请求参数无效", 422), requestId);
  }
  try {
    const result = await createReconciliation({
      actor: session,
      ip: clientIp(req),
      idempotencyKey: key,
      ...parsed.data,
    });
    return reconciliationData(result.body, requestId, result.status);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
