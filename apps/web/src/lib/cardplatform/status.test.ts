import { describe, expect, it } from "vitest";
import {
  mapCardplatformStatus,
  parseCardplatformRequestId,
  redeemOutcomeStatus,
  requestIdForRedeem,
} from "./status";

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
    expect(mapCardplatformStatus({ code: 500 }, true)).toBe("unknown");
  });

  // responseOk=false 只有轮询路径以外的调用方会传。轮询固定传 true，兑换路径走
  // redeemOutcomeStatus，所以这一行是映射器自己的契约，不是兑换的定性规则。
  it("responseOk=false 时兜底成 failed —— 兑换路径不许直接用这一条", () => {
    expect(mapCardplatformStatus({ order: { status: "kyc_hold" } }, false)).toBe("failed");
    expect(mapCardplatformStatus({ error: "bad gateway" }, false)).toBe("failed");
  });
});

describe("redeemOutcomeStatus", () => {
  const at = (status: number, payload: Record<string, unknown>, ok = false) =>
    redeemOutcomeStatus({ ok, status, payload });

  it("代理自己传输失败回的 5xx {error} 只能算未知，卡可能已经扣过费了", () => {
    expect(at(502, { error: "dial tcp: connection refused" })).toBe("unknown");
    expect(at(500, { error: "internal error" })).toBe("unknown");
    expect(at(503, { message: "service unavailable" })).toBe("unknown");
  });

  it("429 / 408 也算未知：限流和超时都可能是请求已经落到卡台了", () => {
    expect(at(429, { error: "too many requests" })).toBe("unknown");
    expect(at(408, { error: "request timeout" })).toBe("unknown");
  });

  it("4xx 是上游明确拒收，可以判失败并退卡", () => {
    expect(at(400, { error: "invalid redemption_token" })).toBe("failed");
    expect(at(404, { error: "not found" })).toBe("failed");
  });

  it("HTTP 200 但带了 error_code：没有结构化终态，仍然只能算未知", () => {
    expect(at(200, { error_code: "CARD_POOL_EMPTY" })).toBe("unknown");
  });

  it("带业务码的 5xx 走业务码那条分支，还是未知", () => {
    expect(at(502, { code: 502, msg: "上游网关错误" })).toBe("unknown");
  });

  it("上游给了结构化终态就照信，与 HTTP 码无关", () => {
    expect(at(400, { order: { status: "declined" } })).toBe("failed");
    expect(at(502, { order: { status: "failed_precharge" } })).toBe("failed");
    expect(at(200, { order: { status: "completed" } }, true)).toBe("success");
  });

  it("受理成功照旧是 pending，非终态照旧透传", () => {
    expect(at(200, { status: "accepted" }, true)).toBe("pending");
    expect(at(200, { order: { status: "review" } }, true)).toBe("processing");
  });

  it("没见过的状态配上 5xx 不再被读成失败", () => {
    expect(at(502, { order: { status: "kyc_hold" } })).toBe("unknown");
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
