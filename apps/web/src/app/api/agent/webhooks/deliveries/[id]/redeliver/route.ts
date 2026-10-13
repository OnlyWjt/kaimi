import { after, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiWebhookDeliveries, apiWebhookEndpoints } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { bootDb } from "@/lib/config";
import { redeliverWebhook } from "@/lib/open-api/webhooks";
import { enforceRateLimitFor } from "@/lib/rate-limit";

/** 把一条历史投递原样再发一次。只能重发自己地址上的投递。 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const limited = enforceRateLimitFor(`agent-webhook-redeliver:${session.agentId}`, 10);
  if (limited) return limited;
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "投递 ID 无效" }, { status: 400 });
  }
  const [owned] = await db
    .select({ id: apiWebhookDeliveries.id, status: apiWebhookEndpoints.status })
    .from(apiWebhookDeliveries)
    .innerJoin(apiWebhookEndpoints, eq(apiWebhookEndpoints.id, apiWebhookDeliveries.endpointId))
    .where(and(eq(apiWebhookDeliveries.id, id), eq(apiWebhookEndpoints.agentId, session.agentId)))
    .limit(1);
  if (!owned) return NextResponse.json({ error: "投递不存在" }, { status: 404 });
  if (owned.status !== "active") {
    return NextResponse.json({ error: "这个回调地址已停用" }, { status: 400 });
  }
  const newId = await redeliverWebhook(id);
  // 不等调度器下一轮，马上发出去，代理点完就能在记录里看到结果。
  after(() => processBackgroundJobs(2).catch(() => undefined));
  return NextResponse.json({ ok: Boolean(newId), id: newId });
}
