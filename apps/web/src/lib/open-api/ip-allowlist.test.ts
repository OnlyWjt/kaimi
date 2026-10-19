import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_ENFORCED_FROM,
  checkKeySource,
  ipInAllowlist,
  MAX_ALLOWLIST_ENTRIES,
  normalizeIp,
  parseAllowlist,
} from "./ip-allowlist";

const beforeDeadline = new Date(Date.parse(ALLOWLIST_ENFORCED_FROM) - 1000);
const afterDeadline = new Date(Date.parse(ALLOWLIST_ENFORCED_FROM) + 1000);

describe("normalizeIp", () => {
  it.each([
    [" 64.32.27.70 ", "64.32.27.70"],
    ["[2001:DB8::1]", "2001:db8::1"],
    ["::ffff:64.32.27.70", "64.32.27.70"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeIp(raw)).toBe(expected);
  });

  it.each(["local", "", "1.2.3", "01.2.3.4", "example.com"])("不是 IP：%s", (raw) => {
    expect(normalizeIp(raw)).toBeNull();
  });
});

describe("parseAllowlist", () => {
  it("单个 IP、网段、IPv6 都认，去重并规范写法", () => {
    expect(
      parseAllowlist(["64.32.27.70", " 64.32.27.70", "198.51.100.0/24", "2001:DB8:1::/64", "8.8.8.8/32", ""]),
    ).toEqual({
      ok: true,
      entries: ["64.32.27.70", "198.51.100.0/24", "2001:db8:1::/64", "8.8.8.8"],
    });
  });

  it("空列表合法，必填与否由调用方判断", () => {
    expect(parseAllowlist([])).toEqual({ ok: true, entries: [] });
  });

  it.each([
    ["0.0.0.0/0", "内网或保留"],
    ["::/0", "内网或保留"],
    ["10.0.0.1", "内网或保留"],
    ["192.168.1.0/24", "内网或保留"],
    ["127.0.0.1", "内网或保留"],
    ["8.8.0.0/16", "范围太大"],
    ["2001:db8::/48", "范围太大"],
    ["8.8.8.8/33", "位数不对"],
    ["8.8.8.8/abc", "位数不对"],
    ["8.8.8.8/24/1", "不是有效"],
    ["abc", "不是有效"],
  ])("拒绝 %s", (raw, message) => {
    const parsed = parseAllowlist([raw]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it(`最多 ${MAX_ALLOWLIST_ENTRIES} 条`, () => {
    const many = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, index) => `8.8.8.${index + 1}`);
    expect(parseAllowlist(many).ok).toBe(false);
    expect(parseAllowlist(many.slice(0, MAX_ALLOWLIST_ENTRIES)).ok).toBe(true);
  });
});

describe("ipInAllowlist", () => {
  const entries = ["64.32.27.70", "198.51.100.0/24", "2001:db8:1::/64"];

  it.each(["64.32.27.70", "198.51.100.200", "::ffff:64.32.27.70", "2001:db8:1::abcd"])("放行 %s", (ip) => {
    expect(ipInAllowlist(ip, entries)).toBe(true);
  });

  it.each(["64.32.27.71", "198.51.101.1", "2001:db8:2::1", "local", ""])("拦下 %s", (ip) => {
    expect(ipInAllowlist(ip, entries)).toBe(false);
  });
});

describe("checkKeySource", () => {
  it("白名单里的 IP 放行，不在的报出来源 IP", () => {
    expect(checkKeySource({ mode: "live", allowlist: ["64.32.27.70"], ip: "64.32.27.70" })).toBeNull();
    expect(checkKeySource({ mode: "live", allowlist: ["64.32.27.70"], ip: "1.1.1.1" })).toContain("1.1.1.1");
  });

  it("测试 Key 填了白名单也照样拦", () => {
    expect(checkKeySource({ mode: "test", allowlist: ["64.32.27.70"], ip: "1.1.1.1" })).not.toBeNull();
  });

  it("测试 Key 不填白名单不限 IP", () => {
    expect(checkKeySource({ mode: "test", allowlist: [], ip: "1.1.1.1", now: afterDeadline })).toBeNull();
  });

  it("正式 Key 没设白名单：宽限期内放行，过了就拒绝并提示来源 IP", () => {
    expect(checkKeySource({ mode: "live", allowlist: [], ip: "1.1.1.1", now: beforeDeadline })).toBeNull();
    const rejected = checkKeySource({ mode: "live", allowlist: [], ip: "1.1.1.1", now: afterDeadline });
    expect(rejected).toContain("还没设置 IP 白名单");
    expect(rejected).toContain("1.1.1.1");
  });
});
