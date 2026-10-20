import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FOLIO_SELF_TEST_VECTOR,
  checkFolioSignature,
  classifyFolioPush,
  classifyFolioRefund,
  folioInvoiceableState,
  folioOrderData,
  folioPushBody,
  folioSelfTest,
  folioSign,
  parseFolioCallback,
  planFolioCallback,
} from "./core";

describe("folioSign", () => {
  it("和约定 §4.3 的自测向量一致", () => {
    const v = FOLIO_SELF_TEST_VECTOR;
    expect(crypto.createHash("sha256").update("").digest("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(folioSign(v.method, v.path, v.ts, v.nonce, v.body, v.secret)).toBe(
      "0134d6cae7d2a6c1fcc1dc1d9ea85bcee3cab9c1b3b45a1647230ee3b079a0e8",
    );
    expect(folioSelfTest().ok).toBe(true);
  });
});

describe("checkFolioSignature", () => {
  const base = {
    method: "POST",
    path: "/api/v1/integrations/folio/callback",
    body: '{"a":1}',
    secret: "s".repeat(32),
    timestamp: "1700000000",
    nonce: "abcdef0123456789",
    nowSeconds: 1700000010,
  };
  const signed = { ...base, signature: folioSign(base.method, base.path, base.timestamp, base.nonce, base.body, base.secret) };

  it("签名对、时间在窗口内通过", () => {
    expect(checkFolioSignature(signed)).toEqual({ ok: true });
  });

  it("时间戳超过 300 秒拒绝", () => {
    expect(checkFolioSignature({ ...signed, nowSeconds: 1700000301 }).ok).toBe(false);
    expect(checkFolioSignature({ ...signed, nowSeconds: 1699999699 }).ok).toBe(false);
  });

  it("nonce 少于 8 位拒绝", () => {
    const nonce = "short";
    const signature = folioSign(base.method, base.path, base.timestamp, nonce, base.body, base.secret);
    expect(checkFolioSignature({ ...signed, nonce, signature }).ok).toBe(false);
  });

  it("签名不对、body 被改、路径不同都拒绝", () => {
    expect(checkFolioSignature({ ...signed, signature: "0".repeat(64) }).ok).toBe(false);
    expect(checkFolioSignature({ ...signed, body: '{"a":2}' }).ok).toBe(false);
    expect(checkFolioSignature({ ...signed, path: "/other" }).ok).toBe(false);
    expect(checkFolioSignature({ ...signed, signature: "" }).ok).toBe(false);
  });

  it("时间戳不是数字拒绝", () => {
    expect(checkFolioSignature({ ...signed, timestamp: "abc" }).ok).toBe(false);
  });
});

const order = {
  orderNo: "KS202610201330AB12CD34EF",
  invoiceRequested: true,
  invoiceAmountCents: 11000,
  invoiceSurchargeCents: 1000,
  grossCents: 11000,
  payStatus: "paid",
  fulfillStatus: "delivered",
  refundedAt: null as string | null,
  currency: "CNY",
  invoiceTitle: "上海某某科技有限公司",
  invoiceTaxNo: "91310000MA1FL2XW3R",
  invoiceEmail: "billing" + String.fromCharCode(64) + "example.com",
  invoiceNote: "合同号 HT-1",
  planKeySnapshot: "chatgpt_plus_month",
  productNameSnapshot: "ChatGPT Plus 月卡",
  quantity: 1,
};

describe("B 查单映射", () => {
  it("五种状态的 invoiceable_state", () => {
    expect(folioInvoiceableState({ ...order, invoiceRequested: false })).toBe("not_requested");
    expect(folioInvoiceableState({ ...order, payStatus: "unpaid" })).toBe("unpaid");
    expect(folioInvoiceableState({ ...order, payStatus: "closed" })).toBe("unpaid");
    expect(folioInvoiceableState({ ...order, payStatus: "refunding" })).toBe("refunding");
    expect(folioInvoiceableState({ ...order, payStatus: "refunded" })).toBe("fully_refunded");
    expect(folioInvoiceableState(order)).toBe("ok");
    expect(folioInvoiceableState({ ...order, invoiceAmountCents: 0 })).not.toBe("ok");
  });

  it("金额按元两位小数，开票金额 = 实付", () => {
    const data = folioOrderData(order);
    expect(data.invoiceable).toBe("110.00");
    expect(data.total_amount).toBe("100.00");
    expect(data.invoice_fee).toBe("10.00");
    expect(data.customer_paid).toBe("110.00");
    expect(data.refunded).toBe("0.00");
    expect(data.consistent).toBe(true);
    expect(data.has_payment_exception).toBe(false);
    expect(data.order_status).toBe("paid/delivered");
    expect(data.items[0]).toEqual({
      product_id: "chatgpt_plus_month",
      title: "ChatGPT Plus 月卡",
      quantity: 1,
      net_amount: "100.00",
    });
    expect(data.buyer).toEqual({
      type: "company",
      name: "上海某某科技有限公司",
      tax_no: "91310000MA1FL2XW3R",
      email: "billing" + String.fromCharCode(64) + "example.com",
      note: "合同号 HT-1",
    });
    expect(folioOrderData({ ...order, invoiceAmountCents: 1 }).invoiceable).toBe("0.01");
  });

  it("已退款时 refunded 等于实付，指纹随状态变化", () => {
    const refunded = folioOrderData({ ...order, payStatus: "refunded", refundedAt: "2026-10-21T00:00:00.000Z" });
    expect(refunded.refunded).toBe("110.00");
    expect(refunded.fingerprint).not.toBe(folioOrderData(order).fingerprint);
    expect(folioOrderData(order).fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("推单 body 带的金额和查单的 invoiceable 同源", () => {
    const body = folioPushBody(order);
    expect(body.invoice_amount).toBe(folioOrderData(order).invoiceable);
    expect(body.order_no).toBe(order.orderNo);
  });
});

function callback(overrides: Record<string, unknown> = {}) {
  const body = parseFolioCallback({
    event_id: "inv:57:v3",
    event: "invoice.issued",
    version: 3,
    order_no: "KS1",
    invoice_id: "57",
    previous_invoice_id: "",
    status: "issued",
    fphm: "26312000000000012345",
    kprq: "2026-10-20 14:03:11",
    pdf_url: "https://folio.example.com/a.pdf",
    red_reason_code: "",
    email_status: "sent",
    ...overrides,
  });
  if (!body) throw new Error("bad body");
  return body;
}

describe("回调处理", () => {
  it("缺字段、版本号不是正整数的不收", () => {
    expect(parseFolioCallback({ event: "invoice.issued", version: 1, order_no: "KS1" })).toBeNull();
    expect(parseFolioCallback({ event_id: "x", event: "invoice.issued", version: 0, order_no: "KS1" })).toBeNull();
    expect(parseFolioCallback(null)).toBeNull();
  });

  it("开具回写订单并通知代理", () => {
    const plan = planFolioCallback(0, callback());
    expect(plan.applied).toBe(true);
    expect(plan.noticeKind).toBe("issued");
    expect(plan.patch).toMatchObject({
      invoiceStatus: "issued",
      invoiceNo: "26312000000000012345",
      invoiceIssuedAt: "2026-10-20 14:03:11",
      folioInvoiceId: "57",
      invoicePdfUrl: "https://folio.example.com/a.pdf",
      invoiceSyncVersion: 3,
      folioPushStatus: "pushed",
    });
  });

  it("版本号不比订单上新的只记录、不回写、不通知", () => {
    expect(planFolioCallback(3, callback())).toEqual({ applied: false, patch: null, noticeKind: "" });
    expect(planFolioCallback(5, callback())).toEqual({ applied: false, patch: null, noticeKind: "" });
  });

  it("previous_invoice_id 非空判为重新开具", () => {
    expect(planFolioCallback(2, callback({ previous_invoice_id: "41" })).noticeKind).toBe("reissued");
  });

  it("file_ready、resync 不通知代理", () => {
    const ready = planFolioCallback(1, callback({ event: "invoice.file_ready", version: 2 }));
    expect(ready.noticeKind).toBe("");
    expect(ready.patch).toEqual({ invoiceSyncVersion: 2, invoicePdfUrl: "https://folio.example.com/a.pdf" });
    expect(planFolioCallback(1, callback({ event: "invoice.resync", version: 2 })).noticeKind).toBe("");
  });

  it("PDF 链接只收 https", () => {
    expect(planFolioCallback(0, callback({ pdf_url: "http://x/a.pdf" })).patch?.invoicePdfUrl).toBe("");
    expect(planFolioCallback(1, callback({ event: "invoice.file_ready", version: 2, pdf_url: "javascript:x" })).patch).toEqual({
      invoiceSyncVersion: 2,
    });
  });

  it("红冲回写作废、清掉 PDF、通知代理", () => {
    const plan = planFolioCallback(3, callback({ event: "invoice.reddened", version: 4, status: "reddened", red_reason_code: "02", pdf_url: "" }));
    expect(plan.noticeKind).toBe("reddened");
    expect(plan.patch).toMatchObject({ invoiceStatus: "reddened", invoicePdfUrl: "", invoiceSyncVersion: 4 });
  });

  it("同步已红冲的票按作废回写，不通知", () => {
    const plan = planFolioCallback(4, callback({ event: "invoice.resync", version: 5, status: "reddened" }));
    expect(plan.patch?.invoiceStatus).toBe("reddened");
    expect(plan.noticeKind).toBe("");
  });

  it("不认识的事件只留记录", () => {
    expect(planFolioCallback(0, callback({ event: "invoice.other" })).applied).toBe(false);
  });
});

describe("推单 / 退款结果", () => {
  it("成功（含重复推送）记推送成功", () => {
    expect(classifyFolioPush(200, { status_code: 0, msg: "", data: { invoice_id: 123, status: "pending_review", duplicate: true } })).toEqual({
      kind: "pushed",
      invoiceId: "123",
      duplicate: true,
    });
  });

  it("400 / 422 不重试，401 是密钥问题，5xx 重试", () => {
    expect(classifyFolioPush(422, { status_code: 422, msg: "推送金额与实付不一致" }).kind).toBe("rejected");
    expect(classifyFolioPush(400, null).kind).toBe("rejected");
    expect(classifyFolioPush(401, null).kind).toBe("unauthorized");
    expect(classifyFolioPush(503, { status_code: 503, msg: "查询订单失败" }).kind).toBe("retry");
    expect(classifyFolioPush(502, null).kind).toBe("retry");
  });

  it("退款推送取回 action，失败交给重试", () => {
    expect(classifyFolioRefund(200, { status_code: 0, msg: "", data: { action: "red_flush" } })).toEqual({ ok: true, action: "red_flush" });
    expect(classifyFolioRefund(503, null).ok).toBe(false);
  });
});
