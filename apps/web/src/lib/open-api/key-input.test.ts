import { describe, expect, it } from "vitest";
import { checkKeyInput } from "./key-input";
import { AGENT_SCOPES, OPEN_API_SCOPES, SCOPE_LABEL, TEST_KEY_CALLABLE_SCOPES, TEST_KEY_GRANTABLE_SCOPES } from "./scopes";

describe("checkKeyInput", () => {
  it("正式 Key 必须填白名单", () => {
    const result = checkKeyInput({ ownerType: "agent", mode: "live", scopes: ["redeem:write"], ipAllowlist: [] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("必须填写 IP 白名单") });
  });

  it("正式 Key 填了白名单就过，权限去重", () => {
    expect(
      checkKeyInput({
        ownerType: "agent",
        mode: "live",
        scopes: ["redeem:write", "redeem:write", "redeem:read"],
        ipAllowlist: ["64.32.27.70"],
      }),
    ).toEqual({ ok: true, scopes: ["redeem:write", "redeem:read"], ipAllowlist: ["64.32.27.70"] });
  });

  it("测试 Key 白名单选填，能勾看卡密明文", () => {
    expect(
      checkKeyInput({ ownerType: "agent", mode: "test", scopes: ["orders:read", "cdks:reveal"], ipAllowlist: [] }).ok,
    ).toBe(true);
  });

  it("测试 Key 不能勾会动真卡真钱的权限", () => {
    const result = checkKeyInput({ ownerType: "agent", mode: "test", scopes: ["redeem:write"], ipAllowlist: [] });
    expect(result.ok).toBe(false);
  });

  it("代理 Key 不能拿平台权限", () => {
    const result = checkKeyInput({
      ownerType: "agent",
      mode: "live",
      scopes: ["earnings:read"],
      ipAllowlist: ["64.32.27.70"],
    });
    expect(result).toEqual({ ok: false, error: "代理 Key 不能包含该权限" });
  });

  it("平台 Key 可以拿平台权限，同样要白名单", () => {
    expect(
      checkKeyInput({ ownerType: "platform", mode: "live", scopes: ["earnings:read"], ipAllowlist: ["64.32.27.70"] }).ok,
    ).toBe(true);
    expect(checkKeyInput({ ownerType: "platform", mode: "live", scopes: ["earnings:read"], ipAllowlist: [] }).ok).toBe(
      false,
    );
  });

  it("白名单写错了把具体哪条报出来", () => {
    const result = checkKeyInput({ ownerType: "agent", mode: "live", scopes: ["plans:read"], ipAllowlist: ["10.0.0.1"] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("10.0.0.1") });
  });
});

describe("测试 Key 的权限范围", () => {
  it("能直接调用的是能勾的子集，cdks:reveal 只能勾不能直接调", () => {
    for (const scope of TEST_KEY_CALLABLE_SCOPES) {
      expect(TEST_KEY_GRANTABLE_SCOPES as readonly string[]).toContain(scope);
    }
    expect(TEST_KEY_GRANTABLE_SCOPES as readonly string[]).toContain("cdks:reveal");
    expect(TEST_KEY_CALLABLE_SCOPES as readonly string[]).not.toContain("cdks:reveal");
  });

  it("测试 Key 能勾的都在代理权限里", () => {
    for (const scope of TEST_KEY_GRANTABLE_SCOPES) {
      expect(AGENT_SCOPES as readonly string[]).toContain(scope);
    }
  });

  it("每个权限都有中文名", () => {
    for (const scope of OPEN_API_SCOPES) expect(SCOPE_LABEL[scope]).toBeTruthy();
  });
});
