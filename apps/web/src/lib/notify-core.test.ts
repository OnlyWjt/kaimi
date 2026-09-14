import { describe, expect, it } from "vitest";
import {
  SAMPLE_NOTIFY_PAYLOAD,
  escapeTelegramHtml,
  formatNotifyText,
  formatStorePaidTelegramHtml,
  formatStorePaidText,
  notifyPaymentChannelLabel,
  notifyYuanFields,
} from "./notify-core";

describe("formatNotifyText", () => {
  it("按代理、开通账号、套餐、售价和收益排版", () => {
    const text = formatNotifyText(SAMPLE_NOTIFY_PAYLOAD);
    expect(text).toContain("[Kaimi] 兑换成功  TEST-NOTIFY");
    expect(text).toContain("代理：测试代理店");
    expect(text).toContain("开通账号：demo@example.com");
    expect(text).toContain("套餐：Plus");
    expect(text).toContain("售价：¥150.00");
    expect(text).toContain("本次收益：¥30.00");
    expect(text).toContain("代理收益：¥115.00");
    expect(text).toContain("这是一条测试通知，不是真实兑换。");
  });

  it("没有商业字段时不留空行", () => {
    const text = formatNotifyText({
      orderNo: "OPS",
      status: "alert",
      message: "卡台余额不足",
    });
    expect(text).toBe("[Kaimi] 运维告警  OPS\n卡台余额不足");
    expect(text).not.toContain("代理：");
    expect(text).not.toContain("售价：");
  });
});

describe("formatStorePaidText", () => {
  const paid = {
    orderNo: "KS20260909001",
    agentName: "onlyWjt",
    buyerEmail: "buyer@example.com",
    amountCents: 16500,
    paymentChannel: "wxpay",
    productName: "gptpt pro 5X",
    quantity: 1,
    invoice: {
      title: "某某科技有限公司",
      note: "项目 A",
      amountCents: 16500,
      email: "finance@example.com",
    },
  };

  it("支付和开票合成一条，不另发待开发票", () => {
    expect(formatStorePaidText(paid)).toBe(
      [
        "[Kaimi] 订单已支付  KS20260909001",
        "这单需要开发票",
        "代理：onlyWjt",
        "购买人：buyer@example.com",
        "订单金额：¥165.00",
        "支付渠道：微信",
        "商品：gptpt pro 5X",
        "抬头：某某科技有限公司",
        "备注：项目 A",
        "开票金额：¥165.00",
        "收票邮箱：finance@example.com",
      ].join("\n"),
    );
  });

  it("没开票就只发支付信息", () => {
    const text = formatStorePaidText({ ...paid, invoice: null });
    expect(text).toContain("[Kaimi] 订单已支付");
    expect(text).not.toContain("这单需要开发票");
    expect(text).not.toContain("抬头：");
    expect(text).not.toContain("收票邮箱：");
  });

  it("Telegram 不能标红，开票提醒用加粗", () => {
    const html = formatStorePaidTelegramHtml({
      ...paid,
      invoice: { ...paid.invoice, title: "A&B <公司>" },
    });
    expect(html).toContain("<b>[Kaimi] 订单已支付  KS20260909001</b>");
    expect(html).toContain("<b>⚠️ 这单需要开发票</b>");
    expect(html).toContain("抬头：A&amp;B &lt;公司&gt;");
    expect(html).not.toContain("<font");
  });

  it("渠道名和 HTML 转义", () => {
    expect(notifyPaymentChannelLabel("alipay")).toBe("支付宝");
    expect(notifyPaymentChannelLabel("wxpay")).toBe("微信");
    expect(escapeTelegramHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });
});

describe("notifyYuanFields", () => {
  it("分转元给 webhook 用", () => {
    expect(notifyYuanFields(SAMPLE_NOTIFY_PAYLOAD)).toEqual({
      retailYuan: "150.00",
      platformYuan: "30.00",
      agentEarningYuan: "115.00",
    });
  });
});
