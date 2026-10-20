import { describe, expect, it } from "vitest";
import {
  afterSalesContacts,
  contactGate,
  contactHref,
  contactValueError,
  graceDeadlineFrom,
  hasSupportContact,
} from "@/lib/agent-contact-core";
import type { ContactItem } from "@/lib/agent-storefront-config";

function item(type: ContactItem["type"], value: string, zh = ""): ContactItem {
  return { type, value, label: { zh, en: "" } };
}

describe("contactValueError", () => {
  it.each([
    ["wechat", "kaimi_help"],
    ["wechat", "wxid-abc123"],
    ["wechat", "13800138000"],
    ["qq", "12345"],
    ["qq", "123456789012"],
    ["telegram", "@kaimi_help"],
    ["telegram", "kaimi_help"],
    ["telegram", "https://t.me/kaimi_help"],
    ["telegram", "t.me/+AbCdEf"],
  ] as const)("%s %s 合法", (type, value) => {
    expect(contactValueError(type, value)).toBeNull();
  });

  it.each([
    ["wechat", "扫码加微信"],
    ["wechat", "abc"],
    ["wechat", "1abcdef"],
    ["qq", "0123456"],
    ["qq", "1234"],
    ["telegram", "@abc"],
    ["telegram", "https://t.me/"],
  ] as const)("%s %s 不合法", (type, value) => {
    expect(contactValueError(type, value)).not.toBeNull();
  });
});

describe("hasSupportContact", () => {
  it("只填邮箱和链接不算", () => {
    expect(hasSupportContact([item("email", "a@b.com"), item("link", "https://x.com")])).toBe(false);
  });
  it("格式不对的微信不算", () => {
    expect(hasSupportContact([item("wechat", "扫码加微信")])).toBe(false);
  });
  it("有一个有效的 QQ 就算", () => {
    expect(hasSupportContact([item("email", "a@b.com"), item("qq", "123456")])).toBe(true);
  });
});

describe("contactGate", () => {
  const now = Date.parse("2026-10-14T00:00:00.000Z");
  it("有联系方式直接放行", () => {
    expect(contactGate(true, "", now)).toEqual({ state: "ok" });
  });
  it("宽限期内只提醒", () => {
    expect(contactGate(false, "2026-10-17T00:00:00.000Z", now).state).toBe("grace");
  });
  it("过了宽限期停止接单", () => {
    expect(contactGate(false, "2026-10-13T00:00:00.000Z", now).state).toBe("blocked");
  });
  it("宽限期配置坏了按已过期处理", () => {
    expect(contactGate(false, "", now).state).toBe("blocked");
  });
  it("宽限期是 3 天", () => {
    expect(graceDeadlineFrom(now)).toBe("2026-10-17T00:00:00.000Z");
  });
});

describe("afterSalesContacts / mail", () => {
  it("微信 QQ TG 排前面，格式不对的去掉", () => {
    const list = afterSalesContacts([
      item("email", "a@b.com"),
      item("wechat", "扫码加微信"),
      item("telegram", "@kaimi_help"),
    ]);
    expect(list.map((c) => c.type)).toEqual(["telegram", "email"]);
  });
  it("Telegram 链接和用户名都能生成跳转", () => {
    expect(contactHref(item("telegram", "@kaimi_help"))).toBe("https://t.me/kaimi_help");
    expect(contactHref(item("telegram", "https://t.me/kaimi_help"))).toBe("https://t.me/kaimi_help");
    expect(contactHref(item("qq", "123456"))).toBeNull();
  });
});
