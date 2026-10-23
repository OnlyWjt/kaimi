import { describe, expect, it } from "vitest";
import {
  INVOICE_DEFAULT_RATE_PCT,
  LEGACY_INVOICE_POLICY,
  effectiveInvoiceRatePct,
  invoiceOrderSnapshot,
  invoicePolicyFor,
  invoiceSurchargeAtRate,
  invoiceSurchargeCents,
  isValidCustomInvoiceRate,
  parseAgentTaxBp,
  quoteStorePayment,
  splitInvoiceSurcharge,
  type InvoicePolicy,
} from "./invoice-core";
import {
  computeOrderLedger,
  earningSnapshotFromOrder,
  verifyLedger,
  type StoredOrderLedger,
} from "./order-ledger-core";
import { calculatePaymentFeeCents } from "./payments/fees";

const feeRule = { ratePpm: 6000, fixedFeeCents: 0 };
const custom = (ratePct: number, agentTaxBp = 100): InvoicePolicy => ({ split: true, ratePct, agentTaxBp });

describe("自定义税点：加价怎么分", () => {
  it("商品 ¥100、17%：买家多付 17，平台 6，代理 11 扣 1% 税 0.11", () => {
    expect(splitInvoiceSurcharge(10000, custom(17))).toEqual({
      surchargeCents: 1700,
      platformCents: 600,
      agentShareCents: 1100,
      agentTaxCents: 11,
      agentNetCents: 1089,
    });
  });

  it("6%：代理分成为 0，不扣税", () => {
    expect(splitInvoiceSurcharge(10000, custom(6))).toEqual({
      surchargeCents: 600,
      platformCents: 600,
      agentShareCents: 0,
      agentTaxCents: 0,
      agentNetCents: 0,
    });
  });

  it("10%：买家付的和老规则一样，代理拿 4 扣税", () => {
    const split = splitInvoiceSurcharge(10000, custom(10));
    expect(split.surchargeCents).toBe(invoiceSurchargeCents(10000));
    expect(split.platformCents).toBe(600);
    expect(split.agentShareCents).toBe(400);
    expect(split.agentTaxCents).toBe(4);
    expect(split.agentNetCents).toBe(396);
  });

  it("小额四舍五入后平台 + 代理仍等于总加价，不多不少 1 分", () => {
    // 1.11 元 × 17% = 0.1887 → 19 分；× 6% = 0.0666 → 7 分；代理 12 分，税 0.12 分 → 0
    expect(splitInvoiceSurcharge(111, custom(17))).toEqual({
      surchargeCents: 19,
      platformCents: 7,
      agentShareCents: 12,
      agentTaxCents: 0,
      agentNetCents: 12,
    });
    // 半分进位：5 元 × 16% = 80 分，平台 30，代理 50 × 1% = 0.5 → 1
    expect(splitInvoiceSurcharge(500, custom(16, 100)).agentTaxCents).toBe(1);
  });

  it("商品额为 0 时全是 0", () => {
    expect(splitInvoiceSurcharge(0, custom(17)).surchargeCents).toBe(0);
    expect(splitInvoiceSurcharge(0, custom(17)).agentNetCents).toBe(0);
  });

  it("扣税比例 0 时代理拿全部分成", () => {
    expect(splitInvoiceSurcharge(10000, custom(17, 0)).agentNetCents).toBe(1100);
  });

  it("老规则：全部加价算平台的，和原来的 10% 完全一致", () => {
    for (const goods of [0, 1, 5, 15, 111, 9999, 15000, 123457]) {
      const split = splitInvoiceSurcharge(goods, LEGACY_INVOICE_POLICY);
      expect(split.surchargeCents).toBe(Math.round(goods / 10));
      expect(split.platformCents).toBe(split.surchargeCents);
      expect(split.agentShareCents).toBe(0);
    }
  });

  it("税点只能是 6–17 的整数，扣税比例 0–20%", () => {
    expect(isValidCustomInvoiceRate(6)).toBe(true);
    expect(isValidCustomInvoiceRate(17)).toBe(true);
    for (const bad of [5, 18, 6.5, Number.NaN, -1]) {
      expect(isValidCustomInvoiceRate(bad)).toBe(false);
      expect(() => splitInvoiceSurcharge(10000, custom(bad))).toThrow();
    }
    expect(() => splitInvoiceSurcharge(10000, custom(10, 2001))).toThrow();
    expect(() => splitInvoiceSurcharge(10000, custom(10, -1))).toThrow();
    expect(() => splitInvoiceSurcharge(-1, custom(10))).toThrow();
    expect(() => splitInvoiceSurcharge(1.5, custom(10))).toThrow();
  });

  it("前台估价和下单用同一个算法", () => {
    for (const goods of [1, 99, 111, 12345, 999999]) {
      for (let rate = 6; rate <= 17; rate += 1) {
        expect(invoiceSurchargeAtRate(goods, rate)).toBe(
          splitInvoiceSurcharge(goods, custom(rate)).surchargeCents,
        );
      }
    }
  });
});

describe("代理开通开关", () => {
  it("没开通：代理自己存的税点不生效，一律老规则", () => {
    expect(invoicePolicyFor({ invoiceRateCustomEnabled: false, invoiceRatePct: 17 }, 100)).toEqual(
      LEGACY_INVOICE_POLICY,
    );
    expect(effectiveInvoiceRatePct({ invoiceRateCustomEnabled: false, invoiceRatePct: 6 })).toBe(
      INVOICE_DEFAULT_RATE_PCT,
    );
  });

  it("开通：按代理的税点和后台扣税比例", () => {
    expect(invoicePolicyFor({ invoiceRateCustomEnabled: true, invoiceRatePct: 8 }, 150)).toEqual({
      split: true,
      ratePct: 8,
      agentTaxBp: 150,
    });
    expect(effectiveInvoiceRatePct({ invoiceRateCustomEnabled: true, invoiceRatePct: 8 })).toBe(8);
  });

  it("开通但库里的税点坏了：下单直接拒绝，不按错的数收钱", () => {
    expect(() => invoicePolicyFor({ invoiceRateCustomEnabled: true, invoiceRatePct: 30 }, 100)).toThrow();
  });

  it("扣税比例设置坏了按 1%", () => {
    expect(parseAgentTaxBp("")).toBe(100);
    expect(parseAgentTaxBp(undefined)).toBe(100);
    expect(parseAgentTaxBp("abc")).toBe(100);
    expect(parseAgentTaxBp("1.5")).toBe(100);
    expect(parseAgentTaxBp("99999")).toBe(100);
    expect(parseAgentTaxBp("0")).toBe(0);
    expect(parseAgentTaxBp("300")).toBe(300);
  });
});

describe("自定义税点：整单账", () => {
  it("商品 ¥200、成本 ¥100、费率 0.6%、17%：代理出整单手续费，拿 22 扣税 0.22", () => {
    const quote = quoteStorePayment({
      goodsCents: 20000,
      costTotalCents: 10000,
      invoiceRequested: true,
      feeRule,
      invoicePolicy: custom(17),
    });
    expect(quote.surchargeCents).toBe(3400);
    expect(quote.payCents).toBe(23400);
    expect(quote.feeCents).toBe(140); // 23400 × 0.6% = 140.4
    expect(quote.feeOnGoodsCents).toBe(140); // 整单都是代理出
    expect(quote.invoice.agentNetCents).toBe(2178);
    expect(quote.earningCents).toBe(20000 + 2178 - 10000 - 140);
    expect(quote.snapshot).toEqual({
      invoiceSurchargeCents: 3400,
      invoiceRatePct: 17,
      invoiceSplit: true,
      invoiceAgentShareCents: 2200,
      invoiceAgentTaxCents: 22,
      invoiceAgentTaxBp: 100,
    });
  });

  it("同一单老规则：代理只出商品额那段手续费，加价全归平台", () => {
    const quote = quoteStorePayment({
      goodsCents: 20000,
      costTotalCents: 10000,
      invoiceRequested: true,
      feeRule,
    });
    expect(quote.surchargeCents).toBe(2000);
    expect(quote.feeOnGoodsCents).toBe(120);
    expect(quote.earningCents).toBe(20000 - 10000 - 120);
    expect(quote.snapshot.invoiceSplit).toBe(false);
    expect(quote.snapshot.invoiceAgentShareCents).toBe(0);
    expect(quote.snapshot.invoiceRatePct).toBe(10);
  });

  it("开通了但这单不开票：和普通单一模一样，快照全 0", () => {
    const plain = quoteStorePayment({ goodsCents: 20000, costTotalCents: 10000, invoiceRequested: false, feeRule });
    const enabled = quoteStorePayment({
      goodsCents: 20000,
      costTotalCents: 10000,
      invoiceRequested: false,
      feeRule,
      invoicePolicy: custom(17),
    });
    expect(enabled.payCents).toBe(plain.payCents);
    expect(enabled.earningCents).toBe(plain.earningCents);
    expect(enabled.snapshot).toEqual(
      invoiceOrderSnapshot(splitInvoiceSurcharge(0, custom(17)), custom(17), false),
    );
    expect(enabled.snapshot.invoiceSplit).toBe(false);
    expect(enabled.snapshot.invoiceRatePct).toBe(0);
  });

  it("6% 时代理比老规则多出平台 6% 上的手续费，不多拿钱", () => {
    const legacy = quoteStorePayment({ goodsCents: 20000, costTotalCents: 10000, invoiceRequested: true, feeRule });
    const six = quoteStorePayment({
      goodsCents: 20000,
      costTotalCents: 10000,
      invoiceRequested: true,
      feeRule,
      invoicePolicy: custom(6),
    });
    expect(six.payCents).toBe(21200);
    // 老规则代理出 120（商品额），6% 代理出整单 21200 × 0.6%
    expect(legacy.earningCents - six.earningCents).toBe(calculatePaymentFeeCents(21200, feeRule) - 120);
  });

  it("网关实际手续费和估算不同：自定义税点单由代理承担实际值，平台手续费为 0", () => {
    const quote = quoteStorePayment({
      goodsCents: 20000,
      costTotalCents: 10000,
      invoiceRequested: true,
      feeRule,
      invoicePolicy: custom(17),
    });
    const ledger = computeOrderLedger(
      {
        grossCents: quote.payCents,
        invoiceSurchargeCents: quote.snapshot.invoiceSurchargeCents,
        invoiceSplit: true,
        invoiceAgentShareCents: quote.snapshot.invoiceAgentShareCents,
        invoiceAgentTaxCents: quote.snapshot.invoiceAgentTaxCents,
        agentCostTotalCents: 10000,
        upstreamCostTotalCents: 8000,
        feeRule,
      },
      { gatewayFeeCents: 160 },
    );
    expect(ledger.agentFeeCents).toBe(160);
    expect(ledger.platformFeeCents).toBe(0);
    expect(ledger.agentEarningCents).toBe(20000 + 2178 - 10000 - 160);
    // 平台：代理成本 + 平台 6% + 扣下的税 − 上游
    expect(ledger.platformProfitCents).toBe(10000 + 1200 + 22 - 8000);
    expect(ledger.invoicePlatformCents).toBe(1200);
    expect(ledger.invoiceAgentNetCents).toBe(2178);
  });

  it("快照对不上就拒绝：分成没开 split、分成超过加价、税超过分成", () => {
    const base = {
      grossCents: 11700,
      invoiceSurchargeCents: 1700,
      agentCostTotalCents: 5000,
      upstreamCostTotalCents: null,
      feeRule,
    };
    expect(() => computeOrderLedger({ ...base, invoiceAgentShareCents: 1100 })).toThrow();
    expect(() =>
      computeOrderLedger({ ...base, invoiceSplit: true, invoiceAgentShareCents: 1800 }),
    ).toThrow();
    expect(() =>
      computeOrderLedger({
        ...base,
        invoiceSplit: true,
        invoiceAgentShareCents: 1100,
        invoiceAgentTaxCents: 1101,
      }),
    ).toThrow();
  });

  it("随机 3 万单：买家实付 = 代理收益 + 平台毛利 + 上游 + 手续费，平台开票那份恒为 6%", () => {
    let seed = 20261023;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let i = 0; i < 30000; i += 1) {
      const goods = next(5_000_000);
      const rate = 6 + next(12);
      const taxBp = next(2001);
      const cost = next(goods + 1);
      const upstream = next(cost + 1);
      const rule = { ratePpm: next(40000), fixedFeeCents: next(50) };
      const policy = custom(rate, taxBp);
      const split = splitInvoiceSurcharge(goods, policy);
      expect(split.platformCents + split.agentShareCents).toBe(split.surchargeCents);
      expect(split.agentNetCents + split.agentTaxCents).toBe(split.agentShareCents);
      expect(split.agentShareCents).toBeGreaterThanOrEqual(0);
      expect(split.agentNetCents).toBeGreaterThanOrEqual(0);
      expect(split.platformCents).toBe(Math.round((goods * 6) / 100));
      expect(split.surchargeCents).toBe(Math.round((goods * rate) / 100));
      const snapshot = invoiceOrderSnapshot(split, policy, true);
      const gross = goods + split.surchargeCents;
      const gateway = next(3) === 0 ? next(gross + 1) : undefined;
      const ledger = computeOrderLedger(
        {
          grossCents: gross,
          invoiceSurchargeCents: snapshot.invoiceSurchargeCents,
          invoiceSplit: snapshot.invoiceSplit,
          invoiceAgentShareCents: snapshot.invoiceAgentShareCents,
          invoiceAgentTaxCents: snapshot.invoiceAgentTaxCents,
          agentCostTotalCents: cost,
          upstreamCostTotalCents: upstream,
          feeRule: rule,
        },
        { gatewayFeeCents: gateway },
      );
      expect(ledger.platformFeeCents).toBe(0);
      expect(ledger.agentFeeCents).toBe(ledger.finalPaymentFeeCents);
      expect(ledger.agentEarningCents).toBe(goods + split.agentNetCents - cost - ledger.finalPaymentFeeCents);
      expect(
        ledger.agentEarningCents + (ledger.platformProfitCents ?? 0) + upstream + ledger.finalPaymentFeeCents,
      ).toBe(gross);
    }
  });
});

describe("收益行和结算验算", () => {
  const order: StoredOrderLedger = {
    grossCents: 23400,
    invoiceSurchargeCents: 3400,
    invoiceSplit: true,
    invoiceAgentShareCents: 2200,
    invoiceAgentTaxCents: 22,
    agentCostTotalCents: 10000,
    upstreamCostTotalCents: 8000,
    feeRatePpm: 6000,
    fixedFeeCents: 0,
    finalPaymentFeeCents: 140,
    agentFeeCents: 140,
    platformFeeCents: 0,
    agentEarningCents: 20000 + 2178 - 10000 - 140,
    platformProfitCents: 10000 + 1200 + 22 - 8000,
  };

  it("收益行：gross 是商品额，开票分成单独一列，加起来等于收益", () => {
    const row = earningSnapshotFromOrder(order);
    expect(row.grossCents).toBe(20000);
    expect(row.invoiceShareCents).toBe(2178);
    expect(row.grossCents + row.invoiceShareCents - row.costCents - row.agentFeeCents).toBe(row.earningCents);
    expect(verifyLedger(order, row)).toEqual([]);
  });

  it("收益行少记开票分成：结算前验算拦下", () => {
    const row = { ...earningSnapshotFromOrder(order), invoiceShareCents: 0 };
    expect(verifyLedger(order, row).map((item) => item.code)).toContain("earning_row_invoice_share");
  });

  it("订单被当成老规则（split 丢了）：验算报错，不会悄悄按老规则结", () => {
    expect(() => verifyLedger({ ...order, invoiceSplit: false })).toThrow();
  });

  it("老规则开票单：收益行开票分成为 0，验算照旧通过", () => {
    const legacy: StoredOrderLedger = {
      ...order,
      grossCents: 22000,
      invoiceSurchargeCents: 2000,
      invoiceSplit: false,
      invoiceAgentShareCents: 0,
      invoiceAgentTaxCents: 0,
      finalPaymentFeeCents: 132,
      agentFeeCents: 120,
      platformFeeCents: 12,
      agentEarningCents: 20000 - 10000 - 120,
      platformProfitCents: 10000 + 2000 - 8000 - 12,
    };
    const row = earningSnapshotFromOrder(legacy);
    expect(row.invoiceShareCents).toBe(0);
    expect(verifyLedger(legacy, row)).toEqual([]);
  });
});
