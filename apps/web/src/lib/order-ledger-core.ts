import {
  calculatePaymentFeeCents,
  type FeeRule,
} from "./payments/fees";

/** 实际手续费比估算多出超过 1 元，并且超过估算的 2 倍，才当异常。 */
export const GATEWAY_FEE_ANOMALY_EXTRA_CENTS = 100;

export type LedgerSnapshot = {
  grossCents: number;
  invoiceSurchargeCents: number;
  /** 自定义税点单：true。不传 = 老规则。 */
  invoiceSplit?: boolean;
  /** 开票加价里代理那份（扣税前）。老规则是 0。 */
  invoiceAgentShareCents?: number;
  /** 从代理那份里扣下的税。 */
  invoiceAgentTaxCents?: number;
  agentCostTotalCents: number;
  upstreamCostTotalCents: number | null;
  feeRule: FeeRule;
};

export type LedgerResult = {
  goodsCents: number;
  /** 代理到手的开票分成 = 代理那份 − 扣税。老规则是 0。 */
  invoiceAgentNetCents: number;
  /** 开票加价里平台那份。 */
  invoicePlatformCents: number;
  finalPaymentFeeCents: number;
  agentFeeCents: number;
  platformFeeCents: number;
  agentEarningCents: number;
  platformProfitCents: number | null;
};

function assertCents(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

/**
 * 一单的全部金额。代理收益和平台毛利只从这里出。
 * 老规则：开票加价归平台；代理只承担商品额上的手续费。没有开票时，网关实收由代理承担。
 * 自定义税点（invoiceSplit）：加价里平台拿 6%，代理那份扣税后进代理收益；整单网关实收由代理承担，
 * 扣下的税留在平台。
 */
export function computeOrderLedger(
  snapshot: LedgerSnapshot,
  opts?: { gatewayFeeCents?: number | null },
): LedgerResult {
  assertCents(snapshot.grossCents, "grossCents");
  assertCents(snapshot.invoiceSurchargeCents, "invoiceSurchargeCents");
  assertCents(snapshot.agentCostTotalCents, "agentCostTotalCents");
  if (snapshot.invoiceSurchargeCents > snapshot.grossCents) {
    throw new Error("invoice surcharge cannot exceed gross");
  }
  if (
    snapshot.upstreamCostTotalCents !== null &&
    (!Number.isSafeInteger(snapshot.upstreamCostTotalCents) ||
      snapshot.upstreamCostTotalCents < 0)
  ) {
    throw new Error("upstreamCostTotalCents must be a non-negative safe integer");
  }

  const split = snapshot.invoiceSplit === true;
  const agentShareCents = snapshot.invoiceAgentShareCents ?? 0;
  const agentTaxCents = snapshot.invoiceAgentTaxCents ?? 0;
  assertCents(agentShareCents, "invoiceAgentShareCents");
  assertCents(agentTaxCents, "invoiceAgentTaxCents");
  if (!split && (agentShareCents > 0 || agentTaxCents > 0)) {
    throw new Error("invoice agent share requires invoiceSplit");
  }
  if (agentShareCents > snapshot.invoiceSurchargeCents) {
    throw new Error("invoice agent share cannot exceed surcharge");
  }
  if (agentTaxCents > agentShareCents) {
    throw new Error("invoice agent tax cannot exceed agent share");
  }
  const invoiceAgentNetCents = agentShareCents - agentTaxCents;
  const invoicePlatformCents = snapshot.invoiceSurchargeCents - agentShareCents;

  const goodsCents = snapshot.grossCents - snapshot.invoiceSurchargeCents;
  const feeOnGross = calculatePaymentFeeCents(snapshot.grossCents, snapshot.feeRule);
  const feeOnGoods = calculatePaymentFeeCents(goodsCents, snapshot.feeRule);
  const gateway = opts?.gatewayFeeCents;
  const finalPaymentFeeCents =
    gateway === undefined || gateway === null ? feeOnGross : gateway;
  assertCents(finalPaymentFeeCents, "gatewayFeeCents");

  const agentFeeCents =
    !split && snapshot.invoiceSurchargeCents > 0 ? feeOnGoods : finalPaymentFeeCents;
  const platformFeeCents = finalPaymentFeeCents - agentFeeCents;
  const agentEarningCents =
    goodsCents + invoiceAgentNetCents - snapshot.agentCostTotalCents - agentFeeCents;
  const platformProfitCents =
    snapshot.upstreamCostTotalCents === null
      ? null
      : snapshot.agentCostTotalCents +
        invoicePlatformCents +
        agentTaxCents -
        snapshot.upstreamCostTotalCents -
        platformFeeCents;

  return {
    goodsCents,
    invoiceAgentNetCents,
    invoicePlatformCents,
    finalPaymentFeeCents,
    agentFeeCents,
    platformFeeCents,
    agentEarningCents,
    platformProfitCents,
  };
}

export function isGatewayFeeAnomalous(estimatedCents: number, actualCents: number) {
  return (
    actualCents > estimatedCents * 2 &&
    actualCents - estimatedCents > GATEWAY_FEE_ANOMALY_EXTRA_CENTS
  );
}

/** 从库里读出来的订单。开票分成三列必须一起选出来，漏选会被当成老规则算错钱，所以不设可选。 */
export type OrderLedgerFields = {
  grossCents: number;
  invoiceSurchargeCents?: number | null;
  invoiceSplit: boolean;
  invoiceAgentShareCents: number;
  invoiceAgentTaxCents: number;
  agentCostTotalCents: number;
  upstreamCostTotalCents?: number | null;
  feeRatePpm: number;
  fixedFeeCents: number;
};

export function ledgerInputFromOrder(order: OrderLedgerFields): LedgerSnapshot {
  return {
    grossCents: order.grossCents,
    invoiceSurchargeCents: order.invoiceSurchargeCents || 0,
    invoiceSplit: order.invoiceSplit,
    invoiceAgentShareCents: order.invoiceAgentShareCents,
    invoiceAgentTaxCents: order.invoiceAgentTaxCents,
    agentCostTotalCents: order.agentCostTotalCents,
    upstreamCostTotalCents: order.upstreamCostTotalCents ?? null,
    feeRule: {
      ratePpm: order.feeRatePpm,
      fixedFeeCents: order.fixedFeeCents,
    },
  };
}

/** 用订单上已经定稿的手续费重算代理承担部分、平台毛利。 */
export function recomputeStoredLedger(
  order: OrderLedgerFields & { finalPaymentFeeCents: number },
) {
  return computeOrderLedger(ledgerInputFromOrder(order), {
    gatewayFeeCents: order.finalPaymentFeeCents,
  });
}

export type StoredOrderLedger = OrderLedgerFields & {
  finalPaymentFeeCents: number;
  agentFeeCents: number;
  platformFeeCents: number;
  agentEarningCents: number;
  platformProfitCents: number | null;
};

export type StoredEarningLedger = {
  grossCents: number;
  /** 收益行上记的开票分成（扣税后）。 */
  invoiceShareCents: number;
  costCents: number;
  agentFeeCents: number;
  earningCents: number;
};

export type LedgerMismatch = {
  code: string;
  expected: number | null;
  actual: number | null;
};

/** 结算前验算。空数组表示订单和收益行都对得上快照。 */
export function verifyLedger(
  order: StoredOrderLedger,
  earning?: StoredEarningLedger | null,
): LedgerMismatch[] {
  const recomputed = recomputeStoredLedger(order);
  const mismatches: LedgerMismatch[] = [];
  const check = (code: string, expected: number | null, actual: number | null) => {
    if (expected !== actual) mismatches.push({ code, expected, actual });
  };
  check("agent_fee", recomputed.agentFeeCents, order.agentFeeCents);
  check("platform_fee", recomputed.platformFeeCents, order.platformFeeCents);
  check("agent_earning", recomputed.agentEarningCents, order.agentEarningCents);
  check("platform_profit", recomputed.platformProfitCents, order.platformProfitCents);
  if (earning) {
    check("earning_row_gross", recomputed.goodsCents, earning.grossCents);
    check("earning_row_invoice_share", recomputed.invoiceAgentNetCents, earning.invoiceShareCents);
    check("earning_row_cost", order.agentCostTotalCents, earning.costCents);
    check("earning_row_agent_fee", order.agentFeeCents, earning.agentFeeCents);
    check("earning_row_earning", order.agentEarningCents, earning.earningCents);
  }
  return mismatches;
}

/**
 * 发卡完成时写入 agent_earnings 的金额。手续费列是代理承担的那一部分。
 * gross 是商品额，开票分成单独一列：earning = gross + invoice_share − cost − agent_fee。
 */
export function earningSnapshotFromOrder(order: {
  grossCents: number;
  invoiceSurchargeCents?: number | null;
  invoiceAgentShareCents: number;
  invoiceAgentTaxCents: number;
  agentCostTotalCents: number;
  agentFeeCents: number;
  finalPaymentFeeCents: number;
  agentEarningCents: number;
}) {
  return {
    grossCents: Math.max(0, order.grossCents - (order.invoiceSurchargeCents || 0)),
    invoiceShareCents: order.invoiceAgentShareCents - order.invoiceAgentTaxCents,
    costCents: order.agentCostTotalCents,
    paymentFeeCents: order.agentFeeCents,
    agentFeeCents: order.agentFeeCents,
    totalFeeCents: order.finalPaymentFeeCents,
    earningCents: order.agentEarningCents,
  };
}
