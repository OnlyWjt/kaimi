import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    notes: z.string().trim().max(500).optional(),
    newPassword: z.string().min(8).max(128).optional(),
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
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        updatedAt: now,
      })
      .where(eq(agents.id, id));

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

  if (data.newPassword !== undefined) {
    await writeAuditLog({
      actor: session,
      action: "admin.agent.password_reset",
      targetType: "agent",
      targetId: id,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });
  }

  return NextResponse.json({ ok: true });
}
