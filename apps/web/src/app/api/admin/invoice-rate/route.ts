import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb, setSetting } from "@/lib/config";
import {
  INVOICE_AGENT_TAX_MAX_BP,
  INVOICE_AGENT_TAX_SETTING,
  isValidAgentTaxBp,
} from "@/lib/invoice-core";
import { getAgentInvoiceTaxBp } from "@/lib/invoice-policy";
import { clientIp } from "@/lib/rate-limit";

const saveSchema = z.object({
  /** 万分比：100 = 1%。 */
  agentTaxBp: z.number().int(),
});

async function authorize() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function GET() {
  const session = await authorize();
  if (session instanceof Response) return session;
  await bootDb();
  return NextResponse.json({ agentTaxBp: await getAgentInvoiceTaxBp() });
}

export async function PUT(req: Request) {
  const session = await authorize();
  if (session instanceof Response) return session;
  await bootDb();
  const parsed = saveSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || !isValidAgentTaxBp(parsed.data.agentTaxBp)) {
    return NextResponse.json(
      { error: `扣税比例要在 0%–${INVOICE_AGENT_TAX_MAX_BP / 100}% 之间，最多两位小数` },
      { status: 400 },
    );
  }
  const before = await getAgentInvoiceTaxBp();
  await setSetting(INVOICE_AGENT_TAX_SETTING, String(parsed.data.agentTaxBp));
  await writeAuditLog({
    actor: session,
    action: "settings.invoice_agent_tax.update",
    targetType: "settings",
    targetId: INVOICE_AGENT_TAX_SETTING,
    metadata: { before, after: parsed.data.agentTaxBp },
    ip: clientIp(req),
  });
  return NextResponse.json({ agentTaxBp: parsed.data.agentTaxBp });
}
