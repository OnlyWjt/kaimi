/** 套餐分类标签：后台填写、代理店铺前台按它分组筛选 */

export const MAX_CATEGORY_LENGTH = 20;

/**
 * 分类标签的统一写法：去掉首尾空白、把中间的连续空白压成一个空格。
 * 后台输入和前台分组都走这里，避免「AI 会员」和「AI  会员」被当成两个分类。
 */
export function normalizeCategory(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_CATEGORY_LENGTH);
}
