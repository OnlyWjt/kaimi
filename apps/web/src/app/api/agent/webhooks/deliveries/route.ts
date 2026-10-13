import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { apiWebhookDeliveries, apiWebhookEndpoints } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

/** 最近 50 条投递，调试回调时看「发没发、对方回了什么」。 */
export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const endpoints = await db
    .select({ id: apiWebhookEndpoints.id, url: apiWebhookEndpoints.url })
    .from(apiWebhookEndpoints)
    .where(eq(apiWebhookEndpoints.agentId, session.agentId));
  if (!endpoints.length) return NextResponse.json({ list: [] });
  const urlById = new Map(endpoints.map((row) => [row.id, row.url]));
  const rows = await db
    .select()
    .from(apiWebhookDeliveries)
    .where(inArray(apiWebhookDeliveries.endpointId, [...urlById.keys()]))
    .orderBy(desc(apiWebhookDeliveries.id))
    .limit(50);
  return NextResponse.json({
    list: rows.map((row) => ({
      id: row.id,
      url: urlById.get(row.endpointId) || "",
      event: row.event,
      attempt: row.attempt,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      deliveredAt: row.deliveredAt,
      nextAttemptAt: row.nextAttemptAt,
      createdAt: row.createdAt,
      payload: row.payloadJson,
    })),
  });
}
