import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, agents, platformPlans } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { coverImageError, inspectCoverImage } from "@/lib/plan-cover-core";
import { writeAgentPlanCover } from "@/lib/plan-cover";

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, session.agentId),
  });
  if (!agent || agent.status !== "active") {
    return NextResponse.json({ error: "代理账号不可用" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  const planKey = String(form?.get("planKey") ?? "").trim();
  const file = form?.get("file");
  if (!planKey || !(file instanceof File)) {
    return NextResponse.json({ error: "请选择套餐和图片" }, { status: 400 });
  }

  const [assignment] = await db
    .select({ id: agentPlanPrices.id })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, session.agentId),
        eq(agentPlanPrices.enabled, true),
        eq(platformPlans.enabled, true),
        eq(platformPlans.planKey, planKey),
      ),
    )
    .limit(1);
  if (!assignment) {
    return NextResponse.json({ error: "该套餐未向当前代理开放" }, { status: 404 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const imageError = coverImageError(bytes);
  if (imageError) return NextResponse.json({ error: imageError }, { status: 400 });
  const info = inspectCoverImage(bytes);
  if (!info) return NextResponse.json({ error: "只接受 PNG、JPG 或 WEBP" }, { status: 400 });

  const url = await writeAgentPlanCover({
    agentId: session.agentId,
    planKey,
    ext: info.ext,
    bytes,
  });
  return NextResponse.json({ url });
}
