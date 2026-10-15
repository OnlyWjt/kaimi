import { afterEach, describe, expect, it, vi } from "vitest";
import { pickClientIp, rateLimit, rateLimitBucketCount } from "./rate-limit";

describe("pickClientIp", () => {
  // 取第一跳的话，客户端自己写一个新值就换一个桶，匿名批量额度等于没有。
  it("默认取最后一跳，客户端伪造的前缀拿不到新桶", () => {
    expect(
      pickClientIp({ forwardedFor: "1.1.1.1, 203.0.113.9" }),
    ).toBe("203.0.113.9");
    expect(
      pickClientIp({ forwardedFor: "9.9.9.9, 8.8.8.8, 203.0.113.9" }),
    ).toBe("203.0.113.9");
  });

  it("多层代理时按配置的层数从右往左数", () => {
    expect(
      pickClientIp({
        forwardedFor: "1.1.1.1, 203.0.113.9, 10.0.0.1",
        hops: 2,
      }),
    ).toBe("203.0.113.9");
  });

  it("链子比声称的短就取最左边，不会越界拿到伪造段", () => {
    expect(pickClientIp({ forwardedFor: "203.0.113.9", hops: 3 })).toBe(
      "203.0.113.9",
    );
  });

  it("可信代理独占的头优先，完全绕开 XFF", () => {
    expect(
      pickClientIp({
        forwardedFor: "1.1.1.1, 2.2.2.2",
        trustedHeaderValue: "203.0.113.9",
      }),
    ).toBe("203.0.113.9");
  });

  it("hops=0 表示直连，一概不信 XFF", () => {
    expect(
      pickClientIp({ forwardedFor: "1.1.1.1", realIp: "203.0.113.9", hops: 0 }),
    ).toBe("203.0.113.9");
  });

  it("本地开发没有任何头，回落到 local", () => {
    expect(pickClientIp({})).toBe("local");
    expect(pickClientIp({ forwardedFor: "  ,  " })).toBe("local");
  });
});

describe("rateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("过期的桶会被清掉，不会一直攒在内存里", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    for (let i = 0; i < 50; i += 1) rateLimit(`sweep-test:${i}`, 5, 1_000);
    expect(rateLimitBucketCount()).toBeGreaterThanOrEqual(50);
    vi.setSystemTime(new Date("2026-10-15T00:05:00Z"));
    rateLimit("sweep-test:fresh", 5, 1_000);
    expect(rateLimitBucketCount()).toBe(1);
  });

  it("窗口内超过次数就拒绝", () => {
    expect(rateLimit("limit-test", 2).ok).toBe(true);
    expect(rateLimit("limit-test", 2).ok).toBe(true);
    expect(rateLimit("limit-test", 2).ok).toBe(false);
  });
});
