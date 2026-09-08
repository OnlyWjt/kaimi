import { describe, expect, it } from "vitest";
import { SAMPLE_NOTIFY_PAYLOAD, formatNotifyText, notifyYuanFields } from "./notify-core";

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

describe("notifyYuanFields", () => {
  it("分转元给 webhook 用", () => {
    expect(notifyYuanFields(SAMPLE_NOTIFY_PAYLOAD)).toEqual({
      retailYuan: "150.00",
      platformYuan: "30.00",
      agentEarningYuan: "115.00",
    });
  });
});
