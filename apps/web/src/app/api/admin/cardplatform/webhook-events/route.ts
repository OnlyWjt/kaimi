import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { authorizeAdmin } from "@/lib/admin-guard";
import { listCardplatformAccounts } from "@/lib/cardplatform/accounts";
import { sanitizeWebhookPayload } from "@/lib/cardplatform/webhook";
import { bootDb } from "@/lib/config";

export async function GET(req: Request) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const url = new URL(req.url);
  const accountId = Number(url.searchParams.get("accountId") || 0);
  const scoped =
    Number.isSafeInteger(accountId) && accountId > 0
      ? db
          .select()
          .from(webhookEvents)
          .where(eq(webhookEvents.accountId, accountId))
      : db.select().from(webhookEvents);
  const rows = await scoped.orderBy(desc(webhookEvents.id)).limit(50);
  const accounts = await listCardplatformAccounts();
  const names = new Map(accounts.map((item) => [item.id, item.name]));
  return NextResponse.json({
    events: rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      accountName: names.get(row.accountId) || `卡台 #${row.accountId}`,
      eventType: row.eventType,
      eventId: row.eventId,
      createdAt: row.processedAt,
      payload: sanitizeWebhookPayload(row.payloadJson),
    })),
  });
}
