import { describe, expect, it } from "vitest";
import {
  checkWebhookUrl,
  checkWebhookUrlSyntax,
  isBlockedIp,
  type LookupAll,
} from "./webhook-url";

const resolveTo =
  (...addresses: string[]): LookupAll =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "[::1]",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it("treats garbage as blocked", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("checkWebhookUrlSyntax", () => {
  it("requires https", () => {
    expect(checkWebhookUrlSyntax("http://example.com/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("ftp://example.com/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://example.com/hook").ok).toBe(true);
  });

  it("rejects malformed urls and credentials", () => {
    expect(checkWebhookUrlSyntax("not a url").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://user:pass@example.com/").ok).toBe(false);
  });

  it("rejects localhost and private literals", () => {
    expect(checkWebhookUrlSyntax("https://localhost/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://LOCALHOST./hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://api.localhost/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://127.0.0.1/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://[::1]/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://[::ffff:192.168.0.1]/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://169.254.169.254/latest").ok).toBe(false);
    // URL 解析器会把十进制/十六进制写法规范化
    expect(checkWebhookUrlSyntax("https://2130706433/hook").ok).toBe(false);
    expect(checkWebhookUrlSyntax("https://0x7f.1/hook").ok).toBe(false);
  });

  it("allows public literals", () => {
    expect(checkWebhookUrlSyntax("https://8.8.8.8/hook").ok).toBe(true);
  });
});

describe("checkWebhookUrl", () => {
  it("passes when every resolved address is public", async () => {
    const res = await checkWebhookUrl("https://example.com/hook", resolveTo("93.184.216.34", "2606:2800::1"));
    expect(res.ok).toBe(true);
  });

  it("rejects when any resolved address is internal", async () => {
    const res = await checkWebhookUrl("https://evil.example/hook", resolveTo("93.184.216.34", "10.0.0.5"));
    expect(res.ok).toBe(false);
  });

  it("rejects ipv6 internal resolutions", async () => {
    expect((await checkWebhookUrl("https://a.example/", resolveTo("fe80::1"))).ok).toBe(false);
    expect((await checkWebhookUrl("https://a.example/", resolveTo("::ffff:127.0.0.1"))).ok).toBe(false);
  });

  it("rejects unresolvable hosts", async () => {
    const failing: LookupAll = async () => {
      throw new Error("ENOTFOUND");
    };
    expect((await checkWebhookUrl("https://nope.example/", failing)).ok).toBe(false);
    expect((await checkWebhookUrl("https://empty.example/", resolveTo())).ok).toBe(false);
  });

  it("does not call DNS for rejected syntax", async () => {
    let called = false;
    const spy: LookupAll = async () => {
      called = true;
      return [];
    };
    expect((await checkWebhookUrl("http://example.com/", spy)).ok).toBe(false);
    expect(called).toBe(false);
  });
});
