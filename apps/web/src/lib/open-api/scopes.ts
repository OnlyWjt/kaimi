export const OPEN_API_SCOPES = [
  "plans:read",
  "orders:read",
  "orders:write",
  "cdks:read",
  "cdks:reveal",
  "redeem:write",
  "redeem:read",
  "earnings:read",
  "agents:read",
] as const;

export const AGENT_SCOPES = [
  "plans:read",
  "orders:read",
  "cdks:read",
  "cdks:reveal",
  "redeem:write",
  "redeem:read",
] as const;

export type OpenApiScopeName = (typeof OPEN_API_SCOPES)[number];

export function isAgentScope(scope: string) {
  return (AGENT_SCOPES as readonly string[]).includes(scope);
}
