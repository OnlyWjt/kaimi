import { yuanTextFromCents } from "./money";

export type RetailPriceBounds = {
  costPriceCents: number;
  maxRetailPriceCents?: number | null;
};

/** 限价列留空或填 0 都当没设上限，老套餐不用回填。 */
export function resolveMaxRetailPriceCents(
  value: number | null | undefined,
): number | null {
  if (value == null) return null;
  const whole = Math.trunc(value);
  return whole > 0 ? whole : null;
}

/** 零售价越界时返回给代理看的中文提示，合法就返回 null。金额一律按元展示。 */
export function retailPriceError(
  retailPriceCents: number,
  bounds: RetailPriceBounds,
): string | null {
  if (retailPriceCents < bounds.costPriceCents) {
    return `零售价不能低于代理成本价 ¥${yuanTextFromCents(bounds.costPriceCents)}`;
  }
  const cap = resolveMaxRetailPriceCents(bounds.maxRetailPriceCents);
  if (cap != null && retailPriceCents > cap) {
    return `零售价不能高于平台限价 ¥${yuanTextFromCents(cap)}`;
  }
  return null;
}

/** 上限压到成本价以下就没人能合法定价了，管理员保存成本或限价时都要先撞这一条。 */
export function maxRetailPriceError(
  maxRetailPriceCents: number | null | undefined,
  costPriceCents: number,
): string | null {
  const cap = resolveMaxRetailPriceCents(maxRetailPriceCents);
  if (cap == null || cap >= costPriceCents) return null;
  return `限价 ¥${yuanTextFromCents(cap)} 低于成本价 ¥${yuanTextFromCents(costPriceCents)}，代理将无法定价`;
}

/** 代理改价输入框旁边的区间提示。 */
export function retailPriceRangeHint(bounds: RetailPriceBounds) {
  const floor = `¥${yuanTextFromCents(bounds.costPriceCents)}`;
  const cap = resolveMaxRetailPriceCents(bounds.maxRetailPriceCents);
  return cap == null ? `不低于 ${floor}` : `${floor} ~ ¥${yuanTextFromCents(cap)}`;
}

/** 限价只拦新的写入，已经高于它的旧价格照卖，后台把这些行标出来让管理员去谈。 */
export function isOverMaxRetailPrice(
  retailPriceCents: number,
  maxRetailPriceCents: number | null | undefined,
) {
  const cap = resolveMaxRetailPriceCents(maxRetailPriceCents);
  return cap != null && retailPriceCents > cap;
}
