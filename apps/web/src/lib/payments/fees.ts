export type PaymentChannel = "alipay" | "wxpay";

export type FeeRule = {
  ratePpm: number;
  fixedFeeCents: number;
};

function assertMoney(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

export function calculatePaymentFeeCents(
  grossCents: number,
  rule: FeeRule,
) {
  assertMoney(grossCents, "grossCents");
  assertMoney(rule.ratePpm, "ratePpm");
  assertMoney(rule.fixedFeeCents, "fixedFeeCents");
  if (rule.ratePpm > 1_000_000) {
    throw new Error("ratePpm cannot exceed 100%");
  }
  const proportional = Number(
    (BigInt(grossCents) * BigInt(rule.ratePpm) + BigInt(500_000)) /
      BigInt(1_000_000),
  );
  return proportional + rule.fixedFeeCents;
}

export function calculateAgentEarningCents(
  grossCents: number,
  agentCostCents: number,
  paymentFeeCents: number,
) {
  assertMoney(grossCents, "grossCents");
  assertMoney(agentCostCents, "agentCostCents");
  assertMoney(paymentFeeCents, "paymentFeeCents");
  return grossCents - agentCostCents - paymentFeeCents;
}
