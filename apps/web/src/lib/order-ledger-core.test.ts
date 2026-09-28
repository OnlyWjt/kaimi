import { describe, expect, it } from "vitest";
import {
  computeOrderLedger,
  isGatewayFeeAnomalous,
  verifyLedger,
  type LedgerResult,
  type StoredOrderLedger,
} from "./order-ledger-core";

function identities(snapshot: Parameters<typeof computeOrderLedger>[0], result: LedgerResult) {
  const goods = snapshot.grossCents - snapshot.invoiceSurchargeCents;
  expect(result.goodsCents).toBe(goods);
  expect(result.finalPaymentFeeCents).toBe(result.agentFeeCents + result.platformFeeCents);
  expect(result.agentEarningCents).toBe(
    goods - snapshot.agentCostTotalCents - result.agentFeeCents,
  );
  if (snapshot.upstreamCostTotalCents !== null) {
    expect(result.platformProfitCents).toBe(
      snapshot.agentCostTotalCents +
        snapshot.invoiceSurchargeCents -
        snapshot.upstreamCostTotalCents -
        result.platformFeeCents,
    );
    expect(
      result.agentEarningCents +
        (result.platformProfitCents ?? 0) +
        snapshot.upstreamCostTotalCents +
        result.finalPaymentFeeCents,
    ).toBe(snapshot.grossCents);
  }
}

describe("computeOrderLedger", () => {
  it("无券无开票：收益等于商品额减成本和手续费", () => {
    const snapshot = {
      grossCents: 14500,
      invoiceSurchargeCents: 0,
      agentCostTotalCents: 12500,
      upstreamCostTotalCents: 12000,
      feeRule: { ratePpm: 7000, fixedFeeCents: 0 },
    };
    const result = computeOrderLedger(snapshot);
    identities(snapshot, result);
    expect(result.agentFeeCents).toBe(102);
    expect(result.agentEarningCents).toBe(1898);
    expect(result.platformProfitCents).toBe(500 - 0);
  });

  it("满减后按券后商品额算收益", () => {
    const snapshot = {
      grossCents: 12600,
      invoiceSurchargeCents: 0,
      agentCostTotalCents: 12500,
      upstreamCostTotalCents: 12000,
      feeRule: { ratePpm: 7000, fixedFeeCents: 0 },
    };
    const result = computeOrderLedger(snapshot);
    identities(snapshot, result);
    expect(result.agentEarningCents).toBe(12);
  });

  it("券把收益压到 0 仍然成立", () => {
    const snapshot = {
      grossCents: 12588,
      invoiceSurchargeCents: 0,
      agentCostTotalCents: 12500,
      upstreamCostTotalCents: null,
      feeRule: { ratePpm: 7000, fixedFeeCents: 0 },
    };
    const result = computeOrderLedger(snapshot);
    identities(snapshot, result);
    expect(result.agentEarningCents).toBeGreaterThanOrEqual(0);
    expect(result.platformProfitCents).toBeNull();
  });

  it("开票单代理只承担商品额手续费，多出来的通道费归平台", () => {
    const snapshot = {
      grossCents: 22000,
      invoiceSurchargeCents: 2000,
      agentCostTotalCents: 10000,
      upstreamCostTotalCents: 8000,
      feeRule: { ratePpm: 60000, fixedFeeCents: 0 },
    };
    const result = computeOrderLedger(snapshot);
    identities(snapshot, result);
    expect(result.agentFeeCents).toBe(1200);
    expect(result.platformFeeCents).toBe(120);
    expect(result.agentEarningCents).toBe(8800);
  });

  it("开票单网关实收小于商品额手续费时，平台手续费可以为负", () => {
    const snapshot = {
      grossCents: 22000,
      invoiceSurchargeCents: 2000,
      agentCostTotalCents: 10000,
      upstreamCostTotalCents: 8000,
      feeRule: { ratePpm: 60000, fixedFeeCents: 0 },
    };
    const result = computeOrderLedger(snapshot, { gatewayFeeCents: 1000 });
    identities(snapshot, result);
    expect(result.agentFeeCents).toBe(1200);
    expect(result.platformFeeCents).toBe(-200);
    expect(result.finalPaymentFeeCents).toBe(1000);
  });

  it("一单多张时固定费只收一次，成本和进价按数量", () => {
    const snapshot = {
      grossCents: 29000,
      invoiceSurchargeCents: 0,
      agentCostTotalCents: 25000,
      upstreamCostTotalCents: 24000,
      feeRule: { ratePpm: 7000, fixedFeeCents: 30 },
    };
    const result = computeOrderLedger(snapshot);
    identities(snapshot, result);
    expect(result.agentFeeCents).toBe(203 + 30);
  });

  it("网关手续费正常时覆盖估算", () => {
    const snapshot = {
      grossCents: 14500,
      invoiceSurchargeCents: 0,
      agentCostTotalCents: 12500,
      upstreamCostTotalCents: 12000,
      feeRule: { ratePpm: 7000, fixedFeeCents: 0 },
    };
    const result = computeOrderLedger(snapshot, { gatewayFeeCents: 90 });
    identities(snapshot, result);
    expect(result.agentFeeCents).toBe(90);
    expect(result.agentEarningCents).toBe(1910);
  });
});

describe("isGatewayFeeAnomalous", () => {
  it("超过估算 2 倍并且多出超过 1 元才算异常", () => {
    expect(isGatewayFeeAnomalous(100, 301)).toBe(true);
    expect(isGatewayFeeAnomalous(100, 180)).toBe(false);
    expect(isGatewayFeeAnomalous(40, 120)).toBe(false);
  });
});

describe("verifyLedger", () => {
  it("快照被改过 1 分就报出来", () => {
    const stored: StoredOrderLedger = {
      grossCents: 14500,
      invoiceSurchargeCents: 0,
      agentCostTotalCents: 12500,
      upstreamCostTotalCents: 12000,
      feeRatePpm: 7000,
      fixedFeeCents: 0,
      finalPaymentFeeCents: 102,
      agentFeeCents: 102,
      platformFeeCents: 0,
      agentEarningCents: 1897,
      platformProfitCents: 500,
    };
    const mismatches = verifyLedger(stored, {
      grossCents: 14500,
      costCents: 12500,
      agentFeeCents: 102,
      earningCents: 1897,
    });
    expect(mismatches.map((item) => item.code)).toContain("agent_earning");
  });

  it("一致的订单和收益行通过", () => {
    const stored: StoredOrderLedger = {
      grossCents: 14500,
      invoiceSurchargeCents: 0,
      agentCostTotalCents: 12500,
      upstreamCostTotalCents: 12000,
      feeRatePpm: 7000,
      fixedFeeCents: 0,
      finalPaymentFeeCents: 102,
      agentFeeCents: 102,
      platformFeeCents: 0,
      agentEarningCents: 1898,
      platformProfitCents: 500,
    };
    expect(
      verifyLedger(stored, {
        grossCents: 14500,
        costCents: 12500,
        agentFeeCents: 102,
        earningCents: 1898,
      }),
    ).toEqual([]);
  });
});
