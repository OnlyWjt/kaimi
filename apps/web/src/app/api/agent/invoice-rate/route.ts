import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { clientIp } from "@/lib/rate-limit";
import {
  INVOICE_CUSTOM_RATE_MAX_PCT,
  INVOICE_CUSTOM_RATE_MIN_PCT,
  INVOICE_DEFAULT_RATE_PCT,
  INVOICE_PLATFORM_RATE_PCT,
  effectiveInvoiceRatePct,
  isValidCustomInvoiceRate,
} from "@/lib/invoice-core";
import { getAgentInvoiceTaxBp } from "@/lib/invoice-policy";

const saveSchema = z.object({ ratePct: z.number() });

async function authorize() {
  try {
    return { session: await requireAgent(), denied: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, denied: error };
    throw error;
  }
}

async function snapshot(agentId: number) {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { invoiceRateCustomEnabled: true, invoiceRatePct: true },
  });
  if (!agent) return null;
  return {
    customEnabled: agent.invoiceRateCustomEnabled,
    /** 买家现在看到、下单时生效的税点。 */
    effectiveRatePct: effectiveInvoiceRatePct(agent),
    /** 代理自己存的税点，没开通时不生效。 */
    ratePct: agent.invoiceRatePct,
    defaultRatePct: INVOICE_DEFAULT_RATE_PCT,
    platformRatePct: INVOICE_PLATFORM_RATE_PCT,
    minRatePct: INVOICE_CUSTOM_RATE_MIN_PCT,
    maxRatePct: INVOICE_CUSTOM_RATE_MAX_PCT,
    agentTaxBp: await getAgentInvoiceTaxBp(),
  };
}

export async function GET() {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();
  const data = await snapshot(session.agentId);
  if (!data) return NextResponse.json({ error: "代理资料不存在" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PUT(req: Request) {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();
  const parsed = saveSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || !isValidCustomInvoiceRate(parsed.data.ratePct)) {
    return NextResponse.json(
      { error: `开票税点只能填 ${INVOICE_CUSTOM_RATE_MIN_PCT}–${INVOICE_CUSTOM_RATE_MAX_PCT} 的整数` },
      { status: 400 },
    );
  }
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, session.agentId),
    columns: { invoiceRateCustomEnabled: true, invoiceRatePct: true },
  });
  if (!agent) return NextResponse.json({ error: "代理资料不存在" }, { status: 404 });
  if (!agent.invoiceRateCustomEnabled) {
    return NextResponse.json({ error: "平台还没给你开通自定义开票税点" }, { status: 403 });
  }
  const updated = await db
    .update(agents)
    .set({ invoiceRatePct: parsed.data.ratePct, updatedAt: new Date().toISOString() })
    .where(and(eq(agents.id, session.agentId), eq(agents.invoiceRateCustomEnabled, true)))
    .returning({ id: agents.id });
  // 读完开关到写入之间被超管关掉了
  if (!updated.length) {
    return NextResponse.json({ error: "平台还没给你开通自定义开票税点" }, { status: 403 });
  }
  await writeAuditLog({
    actor: session,
    action: "agent.invoice_rate.update",
    targetType: "agent",
    targetId: session.agentId,
    metadata: { before: agent.invoiceRatePct, after: parsed.data.ratePct },
    ip: clientIp(req),
  });
  return NextResponse.json(await snapshot(session.agentId));
}
