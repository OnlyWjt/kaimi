import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { backgroundJobs } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const schema = z.object({ id: z.number().int().positive() });

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db.query.backgroundJobs.findMany({
    where: inArray(backgroundJobs.status, ["failed", "retrying", "running"]),
    orderBy: [desc(backgroundJobs.updatedAt)],
    limit: 200,
  });
  return NextResponse.json({ list });
}

export async function PATCH(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const [updated] = await db
    .update(backgroundJobs)
    .set({
      status: "pending",
      attempts: 0,
      runAfter: now,
      lockedAt: null,
      lockedBy: "",
      lastError: "",
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(backgroundJobs.id, parsed.data.id),
        inArray(backgroundJobs.status, ["failed", "retrying"]),
      ),
    )
    .returning();
  if (!updated) {
    return NextResponse.json(
      { error: "任务不存在或当前状态不可重试" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: session,
    action: "admin.background_job.retry",
    targetType: "background_job",
    targetId: updated.id,
  });
  return NextResponse.json({ ok: true });
}
