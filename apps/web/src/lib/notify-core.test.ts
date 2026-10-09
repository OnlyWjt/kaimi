import { describe, expect, it } from "vitest";
import {
  SAMPLE_NOTIFY_PAYLOAD,
  escapeTelegramHtml,
  formatDrawAlertText,
  formatDrawApplyTelegramHtml,
  formatDrawApplyText,
  formatDrawCreatedText,
  formatAgentStorePaidText,
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
    expect(text).toContain("挂牌价：¥150.00");
    expect(text).toContain("实付商品额：¥150.00");
    expect(text).toContain("代理成本：¥30.00");
    expect(text).toContain("代理收益：¥115.00（已扣手续费 ¥5.00）");
    expect(text).toContain("平台毛利：¥10.00（上游 ¥20.00）");
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
    productName: "Pro",
    quantity: 1,
    invoice: {
      title: "某某科技有限公司",
      taxNo: "91310000MA1FL2XW3R",
      note: "项目 A",
      amountCents: 16500,
      email: "finance@example.com",
    },
  };

  it("支付和开票合成一条，不另发待开发票", () => {
    expect(formatStorePaidText(paid)).toBe(
      [
        "[Kaimi] 客户下单  KS20260909001",
        "这单需要开发票",
        "代理：onlyWjt",
        "购买人：buyer@example.com",
        "订单金额：¥165.00",
        "支付渠道：微信",
        "套餐：Pro",
        "抬头：某某科技有限公司",
        "税号：91310000MA1FL2XW3R",
        "备注：项目 A",
        "开票金额：¥165.00",
        "收票邮箱：finance@example.com",
      ].join("\n"),
    );
  });

  it("带上代理、套餐和这笔收益", () => {
    const text = formatStorePaidText({
      ...paid,
      invoice: null,
      listGoodsCents: 103800,
      goodsCents: 103173,
      couponCode: "MAN19",
      couponDiscountCents: 627,
      agentCostTotalCents: 103000,
      agentFeeCents: 100,
      agentEarningCents: 73,
      upstreamCostTotalCents: 100000,
      platformProfitCents: 2900,
    });
    expect(text).toContain("代理：onlyWjt");
    expect(text).toContain("购买人：buyer@example.com");
    expect(text).toContain("套餐：Pro");
    expect(text).toContain("挂牌价：¥1038.00");
    expect(text).toContain("优惠券：MAN19  -¥6.27");
    expect(text).toContain("实付商品额：¥1031.73");
    expect(text).toContain("代理成本：¥1030.00");
    expect(text).toContain("代理收益：¥0.73（已扣手续费 ¥1.00）");
    expect(text).toContain("平台毛利：¥29.00（上游 ¥1000.00）");
    expect(text).not.toContain("这单需要开发票");
  });

  it("没开票就只发支付信息", () => {
    const text = formatStorePaidText({ ...paid, invoice: null });
    expect(text).toContain("[Kaimi] 客户下单");
    expect(text).not.toContain("这单需要开发票");
    expect(text).not.toContain("抬头：");
    expect(text).not.toContain("收票邮箱：");
  });

  it("Telegram 不能标红，开票提醒用加粗", () => {
    const html = formatStorePaidTelegramHtml({
      ...paid,
      invoice: { ...paid.invoice, title: "A&B <公司>" },
    });
    expect(html).toContain("<b>[Kaimi] 客户下单  KS20260909001</b>");
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

describe("自助提卡通知", () => {
  const apply = {
    kind: "apply" as const,
    agentName: "Polus",
    username: "polus01",
    agentId: 12,
    shopUrl: "https://kaimi.example.com/s/polus",
    contact: "@polus_tg",
    expectedMonthlyLabel: "50–200 张",
    note: "<script>alert(1)</script>",
    paidOrderCount: 138,
    recentPaidOrderCount: 42,
    appliedAt: "2026-09-30 15:30",
    adminUrl: "https://kaimi.example.com/admin?tab=draw",
  };

  it("申请通知带代理、联系方式、订单量和审批链接", () => {
    const text = formatDrawApplyText(apply);
    expect(text).toContain("[Kaimi] 代理申请开通自助提卡");
    expect(text).toContain("代理：Polus（账号 polus01 · ID 12）");
    expect(text).toContain("已有商城订单：138 单 · 近 30 天 42 单");
    expect(text).toContain("去审批：https://kaimi.example.com/admin?tab=draw");
  });

  it("代理填的内容在 HTML 里被转义", () => {
    const html = formatDrawApplyTelegramHtml(apply);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("催审批带首次申请时间", () => {
    const text = formatDrawApplyText({ ...apply, kind: "remind", firstAppliedHoursAgo: 7 });
    expect(text).toContain("代理催审批");
    expect(text).toContain("首次申请：7 小时前");
  });

  it("提卡通知：部分出卡和毛利", () => {
    const text = formatDrawCreatedText({
      drawNo: "DR1",
      agentName: "Polus",
      planName: "Plus",
      quantity: 3,
      issuedCount: 2,
      unitPriceCents: 12500,
      amountCents: 25000,
      exposureCents: 87500,
      limitCents: 300000,
      upstreamCostUnitCents: 12000,
    });
    expect(text).toContain("代理提卡（部分：2/3）  DR1");
    expect(text).toContain("本次：¥250.00");
    expect(text).toContain("（29%）");
    expect(text).toContain("平台毛利：¥10.00（上游 ¥120.00/张）");
  });

  it("上游进价未配置时不出现毛利", () => {
    const text = formatDrawCreatedText({
      drawNo: "DR1",
      agentName: "Polus",
      planName: "Plus",
      quantity: 1,
      issuedCount: 1,
      unitPriceCents: 12500,
      amountCents: 12500,
      exposureCents: 12500,
      limitCents: 300000,
      upstreamCostUnitCents: null,
    });
    expect(text).not.toContain("平台毛利");
  });

  it("告警", () => {
    expect(
      formatDrawAlertText({
        kind: "credit_warning",
        agentName: "Polus",
        exposureCents: 255000,
        limitCents: 300000,
        adminUrl: "",
      }),
    ).toContain("（85%）");
    expect(
      formatDrawAlertText({
        kind: "recover_failed",
        agentName: "Polus",
        drawNo: "DR9",
        planName: "Plus",
        quantity: 3,
        adminUrl: "",
      }),
    ).toContain("需人工核对：DR9");
  });
});

describe("formatAgentStorePaidText", () => {
  it("只写店铺自己的单，不含平台毛利和上游", () => {
    const text = formatAgentStorePaidText({
      orderNo: "KS1",
      agentName: "For-Vibe-Coding",
      buyerEmail: "buyer@example.com",
      amountCents: 500,
      paymentChannel: "wxpay",
      productName: "GPT 成品号",
      agentEarningCents: 196,
      agentFeeCents: 4,
      platformProfitCents: 80,
      upstreamCostTotalCents: 200,
      invoice: {
        title: "某某公司",
        taxNo: "91310000",
        note: "",
        amountCents: 500,
        email: "finance@example.com",
      },
    });
    expect(text).toBe(
      [
        "[For-Vibe-Coding] 有人下单  KS1",
        "购买人：buyer@example.com",
        "订单金额：¥5.00",
        "支付渠道：微信",
        "套餐：GPT 成品号",
        "你的收益：¥1.96（已扣手续费 ¥0.04）",
        "这单买家要发票",
      ].join("\n"),
    );
    expect(text).not.toContain("平台毛利");
    expect(text).not.toContain("上游");
    expect(text).not.toContain("税号");
    expect(text).not.toContain("代理：");
  });
});

describe("notifyYuanFields", () => {
  it("分转元给 webhook 用", () => {
    expect(notifyYuanFields(SAMPLE_NOTIFY_PAYLOAD)).toEqual({
      retailYuan: "150.00",
      platformYuan: "10.00",
      agentEarningYuan: "115.00",
    });
  });
});
