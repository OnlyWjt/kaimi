import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { finishedAccounts } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const patchSchema = z.object({
  status: z.literal("disabled"),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "库存 ID 无效" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "只能把未售出的成品号作废" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const [updated] = await db
    .update(finishedAccounts)
    .set({ status: "disabled", updatedAt: now })
    .where(
      and(eq(finishedAccounts.id, id), eq(finishedAccounts.status, "unused")),
    )
    .returning({ id: finishedAccounts.id, email: finishedAccounts.email });
  if (!updated) {
    return NextResponse.json(
      { error: "只能作废未售出的成品号" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: session,
    action: "admin.finished_account.disable",
    targetType: "finished_account",
    targetId: updated.id,
    metadata: { email: updated.email },
  });
  return NextResponse.json({ ok: true });
}
