import { allowlistRequired, parseAllowlist, type KeyMode } from "./ip-allowlist";
import { AGENT_SCOPES, isTestKeyGrantableScope } from "./scopes";

/**
 * 新建和编辑 Key 共用的校验：权限范围、测试 Key 能勾什么、IP 白名单。
 * 提卡权限要查库看代理开没开通，留给路由自己判断。
 */
export function checkKeyInput(input: {
  ownerType: "platform" | "agent";
  mode: KeyMode;
  scopes: readonly string[];
  ipAllowlist: readonly string[];
}): { ok: true; scopes: string[]; ipAllowlist: string[] } | { ok: false; error: string } {
  const scopes = [...new Set(input.scopes)];
  if (!scopes.length) return { ok: false, error: "至少勾一个权限" };
  if (input.ownerType === "agent" && scopes.some((scope) => !(AGENT_SCOPES as readonly string[]).includes(scope))) {
    return { ok: false, error: "代理 Key 不能包含该权限" };
  }
  if (input.mode === "test" && scopes.some((scope) => !isTestKeyGrantableScope(scope))) {
    return { ok: false, error: "测试 Key 只能勾查套餐、查订单、代客下单和看卡密明文" };
  }
  const allowlist = parseAllowlist(input.ipAllowlist);
  if (!allowlist.ok) return allowlist;
  if (!allowlist.entries.length && allowlistRequired(input.mode)) {
    return { ok: false, error: "正式 Key 必须填写 IP 白名单，只有白名单里的服务器能调用" };
  }
  return { ok: true, scopes, ipAllowlist: allowlist.entries };
}
