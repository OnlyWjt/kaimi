import { computeOrderLedger } from "./order-ledger-core";
import type { FeeRule } from "./payments/fees";

/** 没开自定义税点的代理：实付上浮 10%，全部归平台，不进代理佣金。 */
export const INVOICE_DEFAULT_RATE_PCT = 10;
/** 开了自定义税点的代理：平台固定拿商品额的 6%，超出部分扣税后归代理。 */
export const INVOICE_PLATFORM_RATE_PCT = 6;
export const INVOICE_CUSTOM_RATE_MIN_PCT = 6;
export const INVOICE_CUSTOM_RATE_MAX_PCT = 17;
/** 代理开票分成的扣税比例，万分比。默认 1%（小规模纳税人）。 */
export const INVOICE_AGENT_TAX_SETTING = "invoice_agent_tax_bp";
export const INVOICE_AGENT_TAX_DEFAULT_BP = 100;
export const INVOICE_AGENT_TAX_MAX_BP = 2000;
export const INVOICE_TITLE_MAX = 120;
export const INVOICE_NOTE_MAX = 200;
/** 纳税人识别号、统一社会信用代码为 15、18 或 20 位。和 Folio 一致，16、17、19 位会被 Folio 拒收。 */
export const INVOICE_TAX_NO_RE = /^(?:[0-9A-Z]{15}|[0-9A-Z]{18}|[0-9A-Z]{20})$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 下单时用哪套开票规则。split = false 是老规则（10% 全归平台，加价上的手续费平台出）；
 * split = true 是自定义税点（平台 6%，余下扣税归代理，整单手续费代理出）。
 */
export type InvoicePolicy =
  | { split: false; ratePct: number; agentTaxBp: 0 }
  | { split: true; ratePct: number; agentTaxBp: number };

export const LEGACY_INVOICE_POLICY: InvoicePolicy = {
  split: false,
  ratePct: INVOICE_DEFAULT_RATE_PCT,
  agentTaxBp: 0,
};

export function isValidCustomInvoiceRate(ratePct: number) {
  return (
    Number.isInteger(ratePct) &&
    ratePct >= INVOICE_CUSTOM_RATE_MIN_PCT &&
    ratePct <= INVOICE_CUSTOM_RATE_MAX_PCT
  );
}

export function isValidAgentTaxBp(bp: number) {
  return Number.isInteger(bp) && bp >= 0 && bp <= INVOICE_AGENT_TAX_MAX_BP;
}

/** 设置里存的扣税比例坏了就退回默认，不让一个坏值把整单算错。 */
export function parseAgentTaxBp(raw: string | null | undefined) {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) return INVOICE_AGENT_TAX_DEFAULT_BP;
  const bp = Number(text);
  return isValidAgentTaxBp(bp) ? bp : INVOICE_AGENT_TAX_DEFAULT_BP;
}

/** 代理没被开通自定义税点时一律走老规则，代理自己存的税点不生效。 */
export function invoicePolicyFor(
  agent: { invoiceRateCustomEnabled: boolean; invoiceRatePct: number },
  agentTaxBp: number,
): InvoicePolicy {
  if (!agent.invoiceRateCustomEnabled) return LEGACY_INVOICE_POLICY;
  if (!isValidCustomInvoiceRate(agent.invoiceRatePct)) {
    throw new Error(`代理开票税点 ${agent.invoiceRatePct}% 不在 6%–17% 之间`);
  }
  if (!isValidAgentTaxBp(agentTaxBp)) throw new Error("开票分成扣税比例无效");
  return { split: true, ratePct: agent.invoiceRatePct, agentTaxBp };
}

/** 买家看到、下单时生效的税点。没开通自定义的代理固定 10%。 */
export function effectiveInvoiceRatePct(agent: {
  invoiceRateCustomEnabled: boolean;
  invoiceRatePct: number;
}) {
  return agent.invoiceRateCustomEnabled && isValidCustomInvoiceRate(agent.invoiceRatePct)
    ? agent.invoiceRatePct
    : INVOICE_DEFAULT_RATE_PCT;
}

/**
 * 买家页面上看到的税点和店铺现在的税点对不上（页面开着时代理改了税点）就拒单，
 * 免得买家按旧价看、按新价付。不开票、或调用方没传期望税点时不核对。
 */
export function assertInvoiceRateUnchanged(input: {
  invoiceRequested: boolean;
  expectedRatePct?: number;
  currentRatePct: number;
}) {
  if (!input.invoiceRequested || input.expectedRatePct === undefined) return;
  if (input.expectedRatePct === input.currentRatePct) return;
  throw new Error(`店铺开票税点已调整为 ${input.currentRatePct}%，请刷新页面确认金额后再支付。`);
}

function assertGoods(goodsCents: number) {
  if (!Number.isSafeInteger(goodsCents) || goodsCents < 0) {
    throw new Error("goodsCents must be a non-negative safe integer");
  }
}

/** 整数分 × 比例，四舍五入到分。用 BigInt，大额也不会有浮点误差。 */
function roundRatio(cents: number, numerator: number, denominator: number) {
  const half = BigInt(Math.floor(denominator / 2));
  return Number((BigInt(cents) * BigInt(numerator) + half) / BigInt(denominator));
}

/** 按税点算买家要多付的开票加价，四舍五入到分。前台估价和下单用同一个算法。 */
export function invoiceSurchargeAtRate(goodsCents: number, ratePct: number) {
  assertGoods(goodsCents);
  if (!Number.isInteger(ratePct) || ratePct < 0 || ratePct > 100) {
    throw new Error("ratePct must be an integer between 0 and 100");
  }
  return roundRatio(goodsCents, ratePct, 100);
}

/** 老规则的开票加价：商品额四舍五入取 10%。 */
export function invoiceSurchargeCents(goodsCents: number) {
  return invoiceSurchargeAtRate(goodsCents, INVOICE_DEFAULT_RATE_PCT);
}

export type InvoiceSplit = {
  /** 买家多付的总加价 = 商品额 × 税点。 */
  surchargeCents: number;
  /** 平台那份（老规则就是全部加价）。 */
  platformCents: number;
  /** 代理那份，扣税前。 */
  agentShareCents: number;
  /** 从代理那份里扣下的税，留给平台交税。 */
  agentTaxCents: number;
  /** 代理实际到手的开票分成。 */
  agentNetCents: number;
};

const NO_INVOICE: InvoiceSplit = {
  surchargeCents: 0,
  platformCents: 0,
  agentShareCents: 0,
  agentTaxCents: 0,
  agentNetCents: 0,
};

/**
 * 一单开票加价怎么分。平台那份按 6% 单独四舍五入，代理拿总加价减平台那份，
 * 所以两份加起来一定等于总加价，不会差 1 分。
 */
export function splitInvoiceSurcharge(goodsCents: number, policy: InvoicePolicy): InvoiceSplit {
  assertGoods(goodsCents);
  if (!policy.split) {
    const surchargeCents = invoiceSurchargeCents(goodsCents);
    return { ...NO_INVOICE, surchargeCents, platformCents: surchargeCents };
  }
  if (!isValidCustomInvoiceRate(policy.ratePct)) throw new Error("开票税点无效");
  if (!isValidAgentTaxBp(policy.agentTaxBp)) throw new Error("开票分成扣税比例无效");
  const surchargeCents = invoiceSurchargeAtRate(goodsCents, policy.ratePct);
  const platformCents = roundRatio(goodsCents, INVOICE_PLATFORM_RATE_PCT, 100);
  const agentShareCents = surchargeCents - platformCents;
  const agentTaxCents = roundRatio(agentShareCents, policy.agentTaxBp, 10_000);
  return {
    surchargeCents,
    platformCents,
    agentShareCents,
    agentTaxCents,
    agentNetCents: agentShareCents - agentTaxCents,
  };
}

/** 订单上要存的开票快照。不开票时全是 0、split = false。 */
export function invoiceOrderSnapshot(split: InvoiceSplit, policy: InvoicePolicy, requested: boolean) {
  if (!requested) {
    return {
      invoiceSurchargeCents: 0,
      invoiceRatePct: 0,
      invoiceSplit: false,
      invoiceAgentShareCents: 0,
      invoiceAgentTaxCents: 0,
      invoiceAgentTaxBp: 0,
    };
  }
  return {
    invoiceSurchargeCents: split.surchargeCents,
    invoiceRatePct: policy.ratePct,
    invoiceSplit: policy.split,
    invoiceAgentShareCents: split.agentShareCents,
    invoiceAgentTaxCents: split.agentTaxCents,
    invoiceAgentTaxBp: policy.agentTaxBp,
  };
}

export function quoteStorePayment(input: {
  goodsCents: number;
  costTotalCents: number;
  invoiceRequested: boolean;
  feeRule: FeeRule;
  /** 不传 = 老规则。开票单必须传代理当前的规则。 */
  invoicePolicy?: InvoicePolicy;
}) {
  assertGoods(input.goodsCents);
  if (!Number.isSafeInteger(input.costTotalCents) || input.costTotalCents < 0) {
    throw new Error("costTotalCents must be a non-negative safe integer");
  }
  const policy = input.invoicePolicy ?? LEGACY_INVOICE_POLICY;
  const split = input.invoiceRequested
    ? splitInvoiceSurcharge(input.goodsCents, policy)
    : NO_INVOICE;
  const snapshot = invoiceOrderSnapshot(split, policy, input.invoiceRequested);
  const payCents = input.goodsCents + split.surchargeCents;
  const ledger = computeOrderLedger({
    grossCents: payCents,
    invoiceSurchargeCents: snapshot.invoiceSurchargeCents,
    invoiceSplit: snapshot.invoiceSplit,
    invoiceAgentShareCents: snapshot.invoiceAgentShareCents,
    invoiceAgentTaxCents: snapshot.invoiceAgentTaxCents,
    agentCostTotalCents: input.costTotalCents,
    upstreamCostTotalCents: null,
    feeRule: input.feeRule,
  });
  return {
    goodsCents: input.goodsCents,
    surchargeCents: split.surchargeCents,
    payCents,
    feeCents: ledger.finalPaymentFeeCents,
    /** 代理承担的手续费。老规则开票单只含商品额那段；自定义税点是整单。 */
    feeOnGoodsCents: ledger.agentFeeCents,
    earningCents: ledger.agentEarningCents,
    invoice: { ...split, ratePct: input.invoiceRequested ? policy.ratePct : 0, split: input.invoiceRequested && policy.split },
    snapshot,
  };
}

/** 老规则下代理只承担售价上的手续费；开票加价及其多出来的通道费归平台。 */
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

/** 代理 GMV 用商品额，不含开票加价。开票分成另算，见订单上的 invoice_agent_share_cents。 */
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
    throw new Error("纳税人识别号须为 15、18 或 20 位字母或数字");
  }
  if (!note) throw new Error("请填写发票备注");
  if (note.length > INVOICE_NOTE_MAX) throw new Error("发票备注过长");
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new Error("请填写有效收票邮箱");
  }
  return { requested: true, title, taxNo, note, email };
}
