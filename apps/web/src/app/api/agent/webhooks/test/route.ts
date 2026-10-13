import { after, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { apiWebhookEndpoints } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { bootDb } from "@/lib/config";
import { queueWebhookPing } from "@/lib/open-api/webhooks";
import { enforceRateLimitFor } from "@/lib/rate-limit";

const schema = z.object({ endpointId: z.number().int().positive() });

/** 给自己的回调地址推一条 ping，看接收端和验签通不通。 */
export async function POST(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const limited = enforceRateLimitFor(`agent-webhook-test:${session.agentId}`, 10);
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "缺少回调地址" }, { status: 400 });
  const endpoint = await db.query.apiWebhookEndpoints.findFirst({
    where: and(
      eq(apiWebhookEndpoints.id, parsed.data.endpointId),
      eq(apiWebhookEndpoints.agentId, session.agentId),
    ),
  });
  if (!endpoint) return NextResponse.json({ error: "回调地址不存在" }, { status: 404 });
  if (endpoint.status !== "active") {
    return NextResponse.json({ error: "这个回调地址已停用" }, { status: 400 });
  }
  const id = await queueWebhookPing(endpoint.id);
  // 不等调度器下一轮，马上发出去，代理点完就能在记录里看到结果。
  after(() => processBackgroundJobs(2).catch(() => undefined));
  return NextResponse.json({ ok: Boolean(id), id });
}
