import { describe, expect, it } from "vitest";
import {
  formatAgentInvoiceNoticeHtml,
  formatAgentInvoiceNoticeText,
  maskInvoiceEmail,
  type AgentInvoiceNotice,
} from "./agent-notice-core";

const AT_QQ = String.fromCharCode(64) + "qq.com";
const mail = (local: string) => local + AT_QQ;

const base: AgentInvoiceNotice = {
  kind: "issued",
  orderNo: "KM202610201330AB12CD34EF",
  productName: "ChatGPT Plus 月卡",
  quantity: 1,
  issuedAt: "2026-10-20 14:03:11",
  email: mail("abcdef"),
  emailStatus: "sent",
  redReasonCode: "",
};

describe("maskInvoiceEmail", () => {
  it("保留前 2 位和域名", () => {
    expect(maskInvoiceEmail(mail("abcdef"))).toBe("ab***" + AT_QQ);
    expect(maskInvoiceEmail(mail("ab"))).toBe("a***" + AT_QQ);
    expect(maskInvoiceEmail(mail("a"))).toBe("a***" + AT_QQ);
    expect(maskInvoiceEmail("")).toBe("");
  });
});

describe("代理开票通知文案", () => {
  it("已开具", () => {
    expect(formatAgentInvoiceNoticeText(base)).toBe(
      [
        "🧾 发票已开具",
        "订单：KM202610201330AB12CD34EF",
        "商品：ChatGPT Plus 月卡 × 1",
        "开票时间：2026-10-20 14:03",
        "已发送到买家收票邮箱 ab***" + AT_QQ,
      ].join("\n"),
    );
  });

  it("已重新开具", () => {
    expect(formatAgentInvoiceNoticeText({ ...base, kind: "reissued" })).toBe(
      [
        "🧾 发票已重新开具",
        "订单：KM202610201330AB12CD34EF",
        "商品：ChatGPT Plus 月卡 × 1",
        "原发票已作废，新发票已发送到买家收票邮箱 ab***" + AT_QQ,
      ].join("\n"),
    );
  });

  it("已作废（红冲）写原因", () => {
    expect(formatAgentInvoiceNoticeText({ ...base, kind: "reddened", redReasonCode: "02" })).toBe(
      [
        "🧾 发票已作废（红冲）",
        "订单：KM202610201330AB12CD34EF",
        "商品：ChatGPT Plus 月卡 × 1",
        "原因：销货退回",
      ].join("\n"),
    );
  });

  it("没发邮件时不说已发送", () => {
    const text = formatAgentInvoiceNoticeText({ ...base, emailStatus: "skipped" });
    expect(text).not.toContain("已发送");
    expect(text).toContain("这张发票没有发邮件");
  });

  it("不带抬头、税号、发票号码、金额", () => {
    const text = formatAgentInvoiceNoticeText(base);
    expect(text).not.toMatch(/抬头|税号|发票号|¥/);
  });

  it("HTML 首行加粗，动态字段转义", () => {
    const html = formatAgentInvoiceNoticeHtml({ ...base, productName: "<b>x</b> & y" });
    expect(html.split("\n")[0]).toBe("<b>🧾 发票已开具</b>");
    expect(html).toContain("商品：&lt;b&gt;x&lt;/b&gt; &amp; y × 1");
  });
});
