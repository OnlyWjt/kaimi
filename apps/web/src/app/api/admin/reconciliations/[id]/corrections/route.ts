import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { addCorrection, ReconciliationError } from "@/lib/reconciliation";
import {
  clientIp,
  idempotencyKey,
  newRequestId,
  reconciliationData,
  reconciliationFail,
} from "@/lib/reconciliation-http";

const schema = z.object({
  sourceItemId: z.number().int().positive(),
  type: z.enum(["refund", "fee_delta", "manual", "reversal"]),
  amountCents: z.number().int(),
  reason: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(128).default(""),
  businessEventKey: z.string().trim().min(3).max(200),
  expectedCorrectionSequence: z.number().int().positive(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
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
  const id = Number((await context.params).id);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!Number.isSafeInteger(id) || id <= 0 || !parsed.success) {
    return reconciliationFail(new ReconciliationError("INVALID_STATE", "请求参数无效", 422), requestId);
  }
  try {
    const result = await addCorrection({
      actor: session,
      ip: clientIp(req),
      idempotencyKey: key,
      batchId: id,
      ...parsed.data,
    });
    return reconciliationData(result.body, requestId, result.status);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
