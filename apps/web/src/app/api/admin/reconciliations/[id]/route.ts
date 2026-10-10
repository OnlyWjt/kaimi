import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { getReconciliation, patchReconciliation, ReconciliationError } from "@/lib/reconciliation";
import {
  clientIp,
  idempotencyKey,
  newRequestId,
  reconciliationData,
  reconciliationFail,
} from "@/lib/reconciliation-http";

const schema = z.object({
  action: z.enum(["confirm", "cancel", "mark_paid", "clear"]),
  expectedVersion: z.number().int().positive(),
  snapshotHash: z.string().min(8),
  direction: z.string().optional(),
  currency: z.string().optional(),
  amountCents: z.number().int().optional(),
  paymentMethod: z.string().optional(),
  paymentReference: z.string().optional(),
  actualPaymentAt: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().optional(),
});

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    return reconciliationFail(error, requestId);
  }
  await bootDb();
  const id = Number((await context.params).id);
  const found = await getReconciliation(id);
  if (!found) return reconciliationFail(new ReconciliationError("INVALID_STATE", "批次不存在", 404), requestId);
  return reconciliationData(
    {
      ...found.batch,
      audits: found.audits.map((row) => ({
        id: row.id,
        action: row.action,
        actorRole: row.actorRole,
        ip: row.ip,
        createdAt: row.createdAt,
        metadata: JSON.parse(row.metadataJson || "{}"),
      })),
    },
    requestId,
  );
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
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
    const result = await patchReconciliation({
      actor: session,
      ip: clientIp(req),
      idempotencyKey: key,
      id,
      action: parsed.data.action,
      expectedVersion: parsed.data.expectedVersion,
      snapshotHash: parsed.data.snapshotHash,
      body: parsed.data,
    });
    return reconciliationData(result.body, requestId, result.status);
  } catch (error) {
    return reconciliationFail(error, requestId);
  }
}
