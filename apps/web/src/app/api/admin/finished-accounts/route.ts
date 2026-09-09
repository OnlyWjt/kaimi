import { NextResponse } from "next/server";
import { and, desc, eq, like, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, finishedAccounts, storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import {
  FINISHED_GPT_PLAN_KEY,
  maskFinishedSecret,
} from "@/lib/finished-account-core";
import { importFinishedAccounts } from "@/lib/finished-accounts";
import {
  DEFAULT_PAGE_SIZE,
  normalizePage,
  normalizePageSize,
} from "@/lib/pagination-core";

async function authorize() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function GET(req: Request) {
  const denied = await authorize();
  if (denied instanceof Response) return denied;
  await bootDb();
  const query = new URL(req.url).searchParams;
  const page = normalizePage(query.get("page"));
  const pageSize = normalizePageSize(query.get("pageSize"), DEFAULT_PAGE_SIZE);
  const status = (query.get("status") || "").trim();
  const q = (query.get("q") || "").trim().toLowerCase();
  const conditions: SQL[] = [eq(finishedAccounts.planKey, FINISHED_GPT_PLAN_KEY)];
  if (status === "unused" || status === "sold" || status === "disabled") {
    conditions.push(eq(finishedAccounts.status, status));
  }
  if (q) {
    conditions.push(like(finishedAccounts.email, `%${q}%`));
  }
  const where = and(...conditions);

  const [totals, [{ total }], list] = await Promise.all([
    db
      .select({
        status: finishedAccounts.status,
        count: sql<number>`count(*)`,
      })
      .from(finishedAccounts)
      .where(eq(finishedAccounts.planKey, FINISHED_GPT_PLAN_KEY))
      .groupBy(finishedAccounts.status),
    db
      .select({ total: sql<number>`count(*)` })
      .from(finishedAccounts)
      .where(where),
    db
      .select({
        id: finishedAccounts.id,
        email: finishedAccounts.email,
        status: finishedAccounts.status,
        importedAt: finishedAccounts.importedAt,
        soldAt: finishedAccounts.soldAt,
        gptPasswordEncrypted: finishedAccounts.gptPasswordEncrypted,
        mailboxPasswordEncrypted: finishedAccounts.mailboxPasswordEncrypted,
        sessionEncrypted: finishedAccounts.sessionEncrypted,
        orderNo: storeOrders.orderNo,
        agentName: agents.displayName,
      })
      .from(finishedAccounts)
      .leftJoin(storeOrders, eq(storeOrders.id, finishedAccounts.storeOrderId))
      .leftJoin(agents, eq(agents.id, storeOrders.agentId))
      .where(where)
      .orderBy(desc(finishedAccounts.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  const counts = { unused: 0, sold: 0, disabled: 0 };
  for (const row of totals) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = Number(row.count || 0);
    }
  }

  return NextResponse.json({
    counts,
    page,
    pageSize,
    total: Number(total || 0),
    list: list.map((row) => ({
      id: row.id,
      email: row.email,
      status: row.status,
      importedAt: row.importedAt,
      soldAt: row.soldAt,
      orderNo: row.orderNo || "",
      agentName: row.agentName || "",
      gptPasswordMasked: maskFinishedSecret(decryptSecret(row.gptPasswordEncrypted)),
      mailboxPasswordMasked: maskFinishedSecret(
        decryptSecret(row.mailboxPasswordEncrypted),
      ),
      sessionMasked: maskFinishedSecret(decryptSecret(row.sessionEncrypted)),
    })),
  });
}

const importSchema = z.object({
  text: z.string().min(1).max(2_000_000),
});

export async function POST(req: Request) {
  const session = await authorize();
  if (session instanceof Response) return session;
  await bootDb();
  const parsed = importSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "入库内容无效" }, { status: 400 });
  }
  const result = await importFinishedAccounts({ text: parsed.data.text });
  await writeAuditLog({
    actor: session,
    action: "admin.finished_account.import",
    targetType: "finished_account",
    metadata: {
      imported: result.imported,
      skipped: result.skipped.length,
      rejected: result.rejected.length,
    },
  });
  return NextResponse.json(result);
}
