import { computeOrderLedger } from "./order-ledger-core";
import type { FeeRule } from "./payments/fees";

/** 开票服务费：实付上浮 10%，归平台，不进代理佣金。 */
export const INVOICE_SURCHARGE_RATE = 0.1;
export const INVOICE_TITLE_MAX = 120;
export const INVOICE_NOTE_MAX = 200;
/** 纳税人识别号、统一社会信用代码常见为 15、18 或 20 位。 */
export const INVOICE_TAX_NO_RE = /^[0-9A-Z]{15,20}$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function invoiceSurchargeCents(goodsCents: number) {
  if (!Number.isSafeInteger(goodsCents) || goodsCents < 0) {
    throw new Error("goodsCents must be a non-negative safe integer");
  }
  return Math.round(goodsCents / 10);
}

export function quoteStorePayment(input: {
  goodsCents: number;
  costTotalCents: number;
  invoiceRequested: boolean;
  feeRule: FeeRule;
}) {
  if (!Number.isSafeInteger(input.goodsCents) || input.goodsCents < 0) {
    throw new Error("goodsCents must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.costTotalCents) || input.costTotalCents < 0) {
    throw new Error("costTotalCents must be a non-negative safe integer");
  }
  const surchargeCents = input.invoiceRequested
    ? invoiceSurchargeCents(input.goodsCents)
    : 0;
  const payCents = input.goodsCents + surchargeCents;
  const ledger = computeOrderLedger({
    grossCents: payCents,
    invoiceSurchargeCents: surchargeCents,
    agentCostTotalCents: input.costTotalCents,
    upstreamCostTotalCents: null,
    feeRule: input.feeRule,
  });
  return {
    goodsCents: input.goodsCents,
    surchargeCents,
    payCents,
    feeCents: ledger.finalPaymentFeeCents,
    feeOnGoodsCents: ledger.agentFeeCents,
    earningCents: ledger.agentEarningCents,
  };
}

/** 代理只承担售价上的手续费；开票加价及其多出来的通道费归平台。 */
export function agentEarningCents(input: {
  goodsCents: number;
  costTotalCents: number;
  feeRule: FeeRule;
  gatewayFeeCents?: number;
  invoiceSurchargeCents?: number | null;
}) {
  const surchargeCents = input.invoiceSurchargeCents || 0;
  return computeOrderLedger(
    {
      grossCents: input.goodsCents + surchargeCents,
      invoiceSurchargeCents: surchargeCents,
      agentCostTotalCents: input.costTotalCents,
      upstreamCostTotalCents: null,
      feeRule: input.feeRule,
    },
    { gatewayFeeCents: input.gatewayFeeCents },
  ).agentEarningCents;
}

/** 代理 GMV / 收益底数用商品额，不含开票加价。 */
export function storeOrderGoodsCents(order: {
  grossCents: number;
  invoiceSurchargeCents?: number | null;
}) {
  return Math.max(0, order.grossCents - (order.invoiceSurchargeCents || 0));
}

export type NormalizedInvoice =
  | { requested: false; title: ""; taxNo: ""; note: ""; email: "" }
  | { requested: true; title: string; taxNo: string; note: string; email: string };

export function normalizeInvoiceRequest(input: {
  requested?: boolean;
  title?: string;
  taxNo?: string;
  note?: string;
  email?: string;
  fallbackEmail?: string;
}): NormalizedInvoice {
  if (!input.requested) {
    return { requested: false, title: "", taxNo: "", note: "", email: "" };
  }
  const title = (input.title ?? "").trim();
  const taxNo = (input.taxNo ?? "").trim().toUpperCase();
  const note = (input.note ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  if (!title) throw new Error("请填写发票抬头");
  if (title.length > INVOICE_TITLE_MAX) throw new Error("发票抬头过长");
  if (!taxNo) throw new Error("请填写纳税人识别号");
  if (!INVOICE_TAX_NO_RE.test(taxNo)) {
    throw new Error("纳税人识别号须为 15–20 位字母或数字");
  }
  if (!note) throw new Error("请填写发票备注");
  if (note.length > INVOICE_NOTE_MAX) throw new Error("发票备注过长");
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new Error("请填写有效收票邮箱");
  }
  return { requested: true, title, taxNo, note, email };
}
