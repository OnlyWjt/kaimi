/** 一次最多买几张由后台配置，没配过就按 5 张。 */
export const DEFAULT_MAX_ORDER_QUANTITY = 5;

/** 后台填错一个数字不能造出天量订单，无论怎么填都不会超过这里。 */
export const HARD_MAX_ORDER_QUANTITY = 50;

/** 后台填的上限：非数字、小于 1、空值都回落到默认值，再夹进硬上限。 */
export function normalizeMaxOrderQuantity(value: unknown) {
  const parsed =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ORDER_QUANTITY;
  const whole = Math.trunc(parsed);
  if (whole < 1) return DEFAULT_MAX_ORDER_QUANTITY;
  return Math.min(whole, HARD_MAX_ORDER_QUANTITY);
}

/**
 * 买家提交的数量。没传按 1 张，超出上限返回 null 让调用方报错——
 * 悄悄改小买家的数量会导致他付的钱和拿到的卡不一致。
 */
export function resolveOrderQuantity(
  value: unknown,
  maxQuantity: number,
): number | null {
  const max = normalizeMaxOrderQuantity(maxQuantity);
  if (value === undefined || value === null || value === "") return 1;
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}
