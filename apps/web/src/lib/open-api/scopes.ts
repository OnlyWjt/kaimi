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

export const DRAW_SCOPES = ["draw:read", "draw:write", "draw:reveal"] as const;

export function isDrawScope(scope: string) {
  return (DRAW_SCOPES as readonly string[]).includes(scope);
}

export type OpenApiScopeName = (typeof OPEN_API_SCOPES)[number];

export function isAgentScope(scope: string) {
  return (AGENT_SCOPES as readonly string[]).includes(scope);
}
