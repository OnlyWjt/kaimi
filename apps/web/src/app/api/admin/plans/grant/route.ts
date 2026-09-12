import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { grantPlanToActiveAgents } from "@/lib/plan-grant";

const schema = z
  .object({
    planKey: z.string().trim().min(1).optional(),
    planKeys: z.array(z.string().trim().min(1)).optional(),
    allEnabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.allEnabled === true ||
      Boolean(data.planKey) ||
      Boolean(data.planKeys?.length),
    { message: "请指定要开放的套餐" },
  );

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }

  try {
    const result = await grantPlanToActiveAgents(parsed.data);
    await writeAuditLog({
      actor: session,
      action: "admin.plan.grant",
      targetType: "platform_plan",
      targetId: result.planKeys.join(","),
      metadata: {
        planKeys: result.planKeys,
        grantedAgentCount: result.grantedAgentCount,
        alreadyAgentCount: result.alreadyAgentCount,
        inserted: result.inserted,
        enabled: result.enabled,
        skipped: result.skipped,
        allEnabled: parsed.data.allEnabled === true,
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "开放失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
