import { describe, expect, it } from "vitest";
import {
  decideBlock,
  failureWeight,
  normalizeGuardEmail,
  retryAfterSeconds,
  sumFailureWeight,
} from "./redeem-guard-core";

describe("normalizeGuardEmail", () => {
  it("去掉加号标签并转小写", () => {
    expect(normalizeGuardEmail(" Attacker+1@Evil.com ")).toBe("attacker@evil.com");
  });

  it("没有 @ 时原样小写", () => {
    expect(normalizeGuardEmail("NotAnEmail")).toBe("notanemail");
  });
});

describe("failureWeight", () => {
  it("预检失败算半次，猜码算一次，成功不算", () => {
    expect(failureWeight("preflight_failed")).toBe(0.5);
    expect(failureWeight("unknown_code")).toBe(1);
    expect(failureWeight("ok")).toBe(0);
    expect(sumFailureWeight(["preflight_failed", "preflight_failed", "unknown_code"])).toBe(2);
  });
});

describe("decideBlock", () => {
  const base = { ip: "1.2.3.4", email: "a@b.com", ipWeight10m: 0, ipWeight24h: 0, emailWeight1h: 0 };

  it("10 分钟 5 次封 30 分钟", () => {
    expect(decideBlock({ ...base, ipWeight10m: 5 })).toMatchObject({
      subjectType: "ip",
      minutes: 30,
    });
  });

  it("24 小时 20 次优先于短窗", () => {
    expect(decideBlock({ ...base, ipWeight10m: 5, ipWeight24h: 20 })).toMatchObject({
      minutes: 24 * 60,
    });
  });

  it("邮箱单独封 1 小时", () => {
    expect(decideBlock({ ...base, emailWeight1h: 5 })).toMatchObject({
      subjectType: "email",
      minutes: 60,
    });
  });

  it("没到阈值不封", () => {
    expect(decideBlock({ ...base, ipWeight10m: 4, emailWeight1h: 4 })).toBeNull();
  });
});

describe("retryAfterSeconds", () => {
  it("按到期时间向上取整", () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    expect(retryAfterSeconds(until)).toBe(90);
  });
});
