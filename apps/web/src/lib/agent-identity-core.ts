export type AgentIdentityInput = {
  agentId?: number;
  displayName?: string | null;
  realName?: string | null;
  settlementName?: string | null;
  shopName?: string | null;
  username?: string | null;
};

/** 超管看到的代理身份：真实姓名 · @登录名 · 店铺名。 */
export function agentIdentityLabel(row: AgentIdentityInput) {
  const who =
    (row.realName || "").trim() ||
    (row.settlementName || "").trim() ||
    (row.displayName || "").trim() ||
    (row.agentId ? `代理 ${row.agentId}` : "");
  const shop = (row.shopName || "").trim();
  const shopPart = shop && shop !== who ? `店铺 ${shop}` : "";
  return [who, row.username ? `@${row.username}` : "", shopPart]
    .filter(Boolean)
    .join(" · ");
}
