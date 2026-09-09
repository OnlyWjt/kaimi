import { describe, expect, it } from "vitest";
import {
  SAMPLE_NOTIFY_PAYLOAD,
  formatInvoicePaidText,
  formatNotifyText,
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

describe("formatInvoicePaidText", () => {
  it("支付确认后单独推开票信息，不和兑换通知混在一起", () => {
    const text = formatInvoicePaidText({
      orderNo: "KS20260909001",
      title: "某某科技有限公司",
      note: "项目 A",
      amountCents: 16500,
      email: "finance@example.com",
      agentName: "onlyWjt",
    });
    expect(text).toBe(
      [
        "[Kaimi] 待开发票  KS20260909001",
        "代理：onlyWjt",
        "抬头：某某科技有限公司",
        "备注：项目 A",
        "开票金额：¥165.00",
        "邮箱：finance@example.com",
      ].join("\n"),
    );
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
