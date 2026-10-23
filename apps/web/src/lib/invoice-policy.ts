import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getSetting } from "@/lib/config";
import {
  INVOICE_AGENT_TAX_SETTING,
  invoicePolicyFor,
  parseAgentTaxBp,
  type InvoicePolicy,
} from "@/lib/invoice-core";

/** 代理开票分成的扣税比例（万分比）。没设置或设置坏了按 1%。 */
export async function getAgentInvoiceTaxBp() {
  return parseAgentTaxBp(await getSetting(INVOICE_AGENT_TAX_SETTING));
}

/** 这个代理现在下开票单用哪套规则。 */
export async function loadAgentInvoicePolicy(agentId: number): Promise<InvoicePolicy> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { invoiceRateCustomEnabled: true, invoiceRatePct: true },
  });
  if (!agent) throw new Error("代理不存在");
  return invoicePolicyFor(agent, await getAgentInvoiceTaxBp());
}
