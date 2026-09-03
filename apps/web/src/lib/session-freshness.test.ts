import { describe, expect, it } from "vitest";
import { isSessionStale } from "./session-freshness";

/** iat 是秒，passwordChangedAt 是 ISO 毫秒，这里统一构造。 */
function iso(ms: number) {
  return new Date(ms).toISOString();
}

describe("isSessionStale", () => {
  it("从没改过密码的账号，会话一直有效", () => {
    expect(isSessionStale(null, 1_700_000_000)).toBe(false);
    expect(isSessionStale("", 1_700_000_000)).toBe(false);
  });

  it("管理员重置密码后，之前签发的会话失效", () => {
    const issuedAt = 1_700_000_000;
    const changedAt = iso((issuedAt + 30) * 1000);
    expect(isSessionStale(changedAt, issuedAt)).toBe(true);
  });

  it("改完密码立刻重新签发的会话仍然有效", () => {
    // 改密码发生在 ...000.450 秒，紧接着签发的 token iat 取整成同一秒。
    const changedAt = iso(1_700_000_000_450);
    expect(isSessionStale(changedAt, 1_700_000_000)).toBe(false);
    expect(isSessionStale(changedAt, 1_700_000_001)).toBe(false);
  });

  it("毫秒不会让上一秒签发的会话侥幸存活", () => {
    const changedAt = iso(1_700_000_001_450);
    expect(isSessionStale(changedAt, 1_700_000_000)).toBe(true);
  });

  it("拿不到或读不懂签发时间就当作过期", () => {
    const changedAt = iso(1_700_000_000_000);
    expect(isSessionStale(changedAt, undefined)).toBe(true);
    expect(isSessionStale(changedAt, "1700000000")).toBe(true);
    expect(isSessionStale(changedAt, Number.NaN)).toBe(true);
  });

  it("时间戳坏掉时不误伤已登录的人", () => {
    expect(isSessionStale("not-a-date", 1_700_000_000)).toBe(false);
  });
});
