export const GRANT_PLANS_SAVE_FIRST = "先保存价格和上限，再开放给代理";

export type GrantAction = "insert" | "enable" | "skip";

/** 代理套餐行还没有、已关掉、已经在卖，三种情况分别怎么处理。 */
export function nextGrantAction(
  existing: { enabled: boolean } | null | undefined,
): GrantAction {
  if (!existing) return "insert";
  if (!existing.enabled) return "enable";
  return "skip";
}

export function formatGrantPlansToast(input: {
  planLabel: string;
  grantedAgentCount: number;
  alreadyAgentCount: number;
}) {
  return `已给 ${input.grantedAgentCount} 家店加上 ${input.planLabel}。${input.alreadyAgentCount} 家本来就能卖。`;
}

export function grantPlansLabel(planNames: string[]) {
  if (planNames.length === 1) return planNames[0];
  if (planNames.length <= 3) return planNames.join("、");
  return `${planNames.length} 个套餐`;
}
