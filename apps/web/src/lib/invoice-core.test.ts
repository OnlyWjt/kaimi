import { describe, expect, it } from "vitest";
import {
  agentEarningCents,
  invoiceSurchargeCents,
  normalizeInvoiceRequest,
  quoteStorePayment,
  storeOrderGoodsCents,
} from "./invoice-core";

const feeRule = { ratePpm: 60000, fixedFeeCents: 0 };

describe("invoiceSurchargeCents", () => {
  it("按商品额四舍五入取 10%", () => {
    expect(invoiceSurchargeCents(15000)).toBe(1500);
    expect(invoiceSurchargeCents(111)).toBe(11);
    expect(invoiceSurchargeCents(0)).toBe(0);
  });
});

describe("quoteStorePayment", () => {
  it("不开票时收款等于商品额，代理收益按商品额扣手续费", () => {
    const quote = quoteStorePayment({
      goodsCents: 15000,
      costTotalCents: 3000,
      invoiceRequested: false,
      feeRule,
    });
    expect(quote.surchargeCents).toBe(0);
    expect(quote.payCents).toBe(15000);
    expect(quote.feeCents).toBe(900);
    expect(quote.earningCents).toBe(11100);
  });

  it("开票时买家付 110%，代理手续费仍按售价抽，加价和多出来的通道费归平台", () => {
    const quote = quoteStorePayment({
      goodsCents: 20000,
      costTotalCents: 10000,
      invoiceRequested: true,
      feeRule,
    });
    expect(quote.surchargeCents).toBe(2000);
    expect(quote.payCents).toBe(22000);
    expect(quote.feeCents).toBe(1320);
    expect(quote.feeOnGoodsCents).toBe(1200);
    expect(quote.earningCents).toBe(8800);
    expect(quote.earningCents + 10000 + quote.feeOnGoodsCents).toBe(20000);
  });
});

describe("agentEarningCents", () => {
  it("开票单代理收益按售价扣手续费，不吃 110% 上多出来的通道费", () => {
    expect(
      agentEarningCents({
        goodsCents: 20000,
        costTotalCents: 10000,
        feeRule,
        gatewayFeeCents: 1320,
        invoiceSurchargeCents: 2000,
      }),
    ).toBe(8800);
  });

  it("不开票时仍用网关手续费", () => {
    expect(
      agentEarningCents({
        goodsCents: 20000,
        costTotalCents: 10000,
        feeRule,
        gatewayFeeCents: 1199,
        invoiceSurchargeCents: 0,
      }),
    ).toBe(8801);
  });
});

describe("storeOrderGoodsCents", () => {
  it("从实付里剥掉开票加价", () => {
    expect(
      storeOrderGoodsCents({ grossCents: 16500, invoiceSurchargeCents: 1500 }),
    ).toBe(15000);
    expect(storeOrderGoodsCents({ grossCents: 15000 })).toBe(15000);
  });
});

describe("normalizeInvoiceRequest", () => {
  it("未勾选时丢掉填写内容", () => {
    expect(
      normalizeInvoiceRequest({
        requested: false,
        title: "某某公司",
        note: "备注",
        email: "a@b.com",
      }),
    ).toEqual({ requested: false, title: "", note: "", email: "" });
  });

  it("勾选后收票邮箱可回落到下单邮箱", () => {
    expect(
      normalizeInvoiceRequest({
        requested: true,
        title: "某某公司",
        note: "项目 A",
        fallbackEmail: "Buyer@Example.com",
      }),
    ).toEqual({
      requested: true,
      title: "某某公司",
      note: "项目 A",
      email: "buyer@example.com",
    });
  });

  it("缺抬头或备注就拒绝", () => {
    expect(() =>
      normalizeInvoiceRequest({
        requested: true,
        note: "备注",
        fallbackEmail: "a@b.com",
      }),
    ).toThrow("请填写发票抬头");
    expect(() =>
      normalizeInvoiceRequest({
        requested: true,
        title: "某某公司",
        fallbackEmail: "a@b.com",
      }),
    ).toThrow("请填写发票备注");
  });
});
