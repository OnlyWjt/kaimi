/** 面向客户和代理自己的店名。空店名回落到超管填写的显示名。 */
export function publicShopName(agent: {
  shopName?: string | null;
  displayName: string;
}) {
  return (agent.shopName || "").trim() || agent.displayName;
}
