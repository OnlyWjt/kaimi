import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, apiKeys, users } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { clientIp } from "@/lib/rate-limit";
import { INVOICE_DEFAULT_RATE_PCT } from "@/lib/invoice-core";

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(64).optional(),
    realName: z.string().trim().max(64).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    notes: z.string().trim().max(500).optional(),
    newPassword: z.string().min(8).max(128).optional(),
    /** 开通后代理能自己设 6%–17% 开票税点，平台固定拿 6%。 */
    invoiceRateCustomEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "至少提供一个修改项",
  });

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "代理 ID 无效" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.query.agents.findFirst({
    where: eq(agents.id, id),
  });
  if (!existing) {
    return NextResponse.json({ error: "代理不存在" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const data = parsed.data;
  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.realName !== undefined ? { realName: data.realName } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.invoiceRateCustomEnabled !== undefined
          ? {
              invoiceRateCustomEnabled: data.invoiceRateCustomEnabled,
              // 关闭时恢复默认税点：下次再开通从 10% 开始，不会突然按上次存的 17% 收
              ...(data.invoiceRateCustomEnabled ? {} : { invoiceRatePct: INVOICE_DEFAULT_RATE_PCT }),
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(agents.id, id));

    if (data.status === "disabled") {
      await tx
        .update(apiKeys)
        .set({ status: "revoked", revokedAt: now })
        .where(eq(apiKeys.agentId, id));
    }

    if (data.status !== undefined || data.newPassword !== undefined) {
      await tx
        .update(users)
        .set({
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.newPassword !== undefined
            ? {
                passwordHash: await bcrypt.hash(data.newPassword, 10),
                passwordChangedAt: now,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(users.agentId, id));
    }
  });

  if (
    data.invoiceRateCustomEnabled !== undefined &&
    data.invoiceRateCustomEnabled !== existing.invoiceRateCustomEnabled
  ) {
    await writeAuditLog({
      actor: session,
      action: data.invoiceRateCustomEnabled
        ? "admin.agent.invoice_rate_enable"
        : "admin.agent.invoice_rate_disable",
      targetType: "agent",
      targetId: id,
      metadata: { invoiceRatePct: existing.invoiceRatePct },
      ip: clientIp(req),
    });
  }

  if (data.newPassword !== undefined) {
    await writeAuditLog({
      actor: session,
      action: "admin.agent.password_reset",
      targetType: "agent",
      targetId: id,
      ip: clientIp(req),
    });
  }

  return NextResponse.json({ ok: true });
}
