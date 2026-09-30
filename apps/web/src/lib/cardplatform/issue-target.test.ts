import { describe, expect, it } from "vitest";
import {
  accountSupportsPaymentCountry,
  isRegionIssueError,
  issueTargetFromSnapshot,
} from "./issue-target";

describe("issueTargetFromSnapshot", () => {
  it("用上游套餐键和地区快照", () => {
    expect(
      issueTargetFromSnapshot({
        planKeySnapshot: "plus:us",
        upstreamPlanKeySnapshot: "plus",
        paymentCountrySnapshot: "us",
      }),
    ).toEqual({ plan: "plus", paymentCountry: "US" });
  });

  it("老订单没有快照时退回 plan_key，不带地区", () => {
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "plus", upstreamPlanKeySnapshot: "", paymentCountrySnapshot: "" }),
    ).toEqual({ plan: "plus", paymentCountry: "" });
  });
});

describe("accountSupportsPaymentCountry", () => {
  it("环境变量账户和旧台协议支持，Avanfinity 不支持", () => {
    expect(accountSupportsPaymentCountry({ id: 0 })).toBe(true);
    expect(accountSupportsPaymentCountry({ id: 3, protocol: "spacexcard-legacy" })).toBe(true);
    expect(accountSupportsPaymentCountry({ id: 3, protocol: "avanfinity-2026-08" })).toBe(false);
  });
});

describe("isRegionIssueError", () => {
  it("按关键词识别地区错误", () => {
    expect(isRegionIssueError({ errorCode: "REGION_DISABLED", message: "" })).toBe(true);
    expect(isRegionIssueError({ message: "不支持该付款地区" })).toBe(true);
    expect(isRegionIssueError({ message: "余额不足" })).toBe(false);
  });

  it("结果未知不算地区错误", () => {
    expect(isRegionIssueError({ message: "region timeout", outcomeUnknown: true })).toBe(false);
  });
});
