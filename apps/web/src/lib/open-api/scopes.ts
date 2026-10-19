export const OPEN_API_SCOPES = [
  "plans:read",
  "orders:read",
  "orders:write",
  "cdks:read",
  "cdks:reveal",
  "redeem:write",
  "redeem:read",
  "draw:read",
  "draw:write",
  "draw:reveal",
  "earnings:read",
  "agents:read",
] as const;

export const AGENT_SCOPES = [
  "plans:read",
  "orders:read",
  "orders:write",
  "cdks:read",
  "cdks:reveal",
  "redeem:write",
  "redeem:read",
  "draw:read",
  "draw:write",
  "draw:reveal",
] as const;

/**
 * 测试 Key 能勾的权限。cdks:reveal 只用来给 GET /orders/{orderNo}?reveal=1 看沙箱假卡，
 * 测试 Key 不能拿它直接调 /cdks/{id}/reveal——那个接口查的是真卡。
 */
export const TEST_KEY_GRANTABLE_SCOPES = ["plans:read", "orders:read", "orders:write", "cdks:reveal"] as const;

/** 测试 Key 能直接调用的接口权限，其余接口会动真卡或真钱。 */
export const TEST_KEY_CALLABLE_SCOPES = ["plans:read", "orders:read", "orders:write"] as const;

export function isTestKeyGrantableScope(scope: string) {
  return (TEST_KEY_GRANTABLE_SCOPES as readonly string[]).includes(scope);
}

/** 给人看的权限名，代理后台和管理后台共用。 */
export const SCOPE_LABEL: Record<string, string> = {
  "plans:read": "查套餐",
  "orders:read": "查订单",
  "orders:write": "代客下单支付",
  "cdks:read": "查卡密",
  "cdks:reveal": "看卡密明文",
  "redeem:write": "提交兑换",
  "redeem:read": "查兑换结果",
  "draw:read": "查提卡",
  "draw:write": "提卡",
  "draw:reveal": "看提卡明文",
  "earnings:read": "查收益",
  "agents:read": "查代理",
};

export const DRAW_SCOPES = ["draw:read", "draw:write", "draw:reveal"] as const;

export function isDrawScope(scope: string) {
  return (DRAW_SCOPES as readonly string[]).includes(scope);
}

export type OpenApiScopeName = (typeof OPEN_API_SCOPES)[number];

export function isAgentScope(scope: string) {
  return (AGENT_SCOPES as readonly string[]).includes(scope);
}
