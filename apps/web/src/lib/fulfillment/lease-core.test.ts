import { describe, expect, it } from "vitest";
import {
  LEASE_PREFIX,
  LeaseLostError,
  isLeaseToken,
  newLeaseToken,
  upstreamRefsSummary,
} from "./lease-core";

describe("lease token", () => {
  it("带前缀且每次唯一", () => {
    const a = newLeaseToken();
    const b = newLeaseToken();
    expect(a.startsWith(LEASE_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(isLeaseToken(a)).toBe(true);
  });

  it("拒绝空值、纯前缀和普通错误码", () => {
    expect(isLeaseToken(null)).toBe(false);
    expect(isLeaseToken(undefined)).toBe(false);
    expect(isLeaseToken("")).toBe(false);
    expect(isLeaseToken(LEASE_PREFIX)).toBe(false);
    expect(isLeaseToken("UPSTREAM_TIMEOUT")).toBe(false);
  });
});

describe("upstreamRefsSummary", () => {
  it("只保留引用和前缀", () => {
    expect(
      upstreamRefsSummary([
        { upstreamRef: "r1", codePrefix: "AB" },
        { upstreamRef: "r2", codePrefix: "CD" },
      ]),
    ).toEqual({ upstreamRefs: ["r1", "r2"], codePrefixes: ["AB", "CD"] });
    expect(upstreamRefsSummary([])).toEqual({ upstreamRefs: [], codePrefixes: [] });
  });
});

describe("LeaseLostError", () => {
  it("可用 instanceof 识别", () => {
    const err = new LeaseLostError();
    expect(err).toBeInstanceOf(LeaseLostError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LeaseLostError");
  });
});
