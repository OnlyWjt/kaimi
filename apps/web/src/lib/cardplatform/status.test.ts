import { describe, expect, it } from "vitest";
import { mapCardplatformStatus, parseCardplatformRequestId, requestIdForRedeem } from "./status";

describe("mapCardplatformStatus", () => {
  it("读嵌套的 order.status —— 这就是以前一直漏掉的那层", () => {
    expect(mapCardplatformStatus({ order: { status: "completed" } }, true)).toBe("success");
    expect(mapCardplatformStatus({ order: { status: "declined" } }, true)).toBe("failed");
  });

  it("扁平返回体照旧", () => {
    expect(mapCardplatformStatus({ status: "completed" }, true)).toBe("success");
    expect(mapCardplatformStatus({ data: { status: "failed" } }, true)).toBe("failed");
  });

  it("declined / failed_precharge 是确定失败，可以退卡重兑", () => {
    expect(mapCardplatformStatus({ order: { status: "failed_precharge" } }, true)).toBe("failed");
    expect(mapCardplatformStatus({ order: { status: "cancelled" } }, true)).toBe("failed");
  });

  it("review 是待对账，按非终态处理：继续查，不给重试入口", () => {
    expect(mapCardplatformStatus({ order: { status: "review" } }, true)).toBe("processing");
    expect(mapCardplatformStatus({ order: { status: "pending" } }, true)).toBe("pending");
  });

  it("queued / running 还在开通中", () => {
    expect(mapCardplatformStatus({ order: { status: "queued" } }, true)).toBe("pending");
    expect(mapCardplatformStatus({ order: { status: "running" } }, true)).toBe("processing");
  });

  it("没见过的状态不当成失败，交给业务码和 HTTP 结果决定", () => {
    expect(mapCardplatformStatus({ order: { status: "kyc_hold" } }, true)).toBe("pending");
    expect(mapCardplatformStatus({ order: { status: "kyc_hold" } }, false)).toBe("failed");
    expect(mapCardplatformStatus({ code: 500 }, true)).toBe("unknown");
  });
});

describe("requestIdForRedeem / parseCardplatformRequestId", () => {
  it("往返得到同一组账号和令牌", () => {
    const rid = requestIdForRedeem(7, "tok:with:colons");
    expect(rid).toBe("cp:7:tok:with:colons");
    expect(parseCardplatformRequestId(rid)).toEqual({
      accountId: 7,
      token: "tok:with:colons",
    });
  });

  it("认不出来的标识返回 null", () => {
    expect(parseCardplatformRequestId("legacy-123")).toBeNull();
  });
});
