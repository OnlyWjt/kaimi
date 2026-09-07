/** 列表分页统一每页 20 条。 */
export const DEFAULT_PAGE_SIZE = 20;

/** 一次拉太多会把后台页面拖垮，接口层无论前端传什么都夹在这里。 */
export const MAX_PAGE_SIZE = 100;

export function normalizePageSize(value: unknown, fallback = DEFAULT_PAGE_SIZE) {
  // 没传就是默认值，不是 0：Number("") 是 0，不判空会一页只剩一条。
  const text = String(value ?? "").trim();
  const parsed = text ? Number(text) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(parsed)));
}

export function normalizePage(value: unknown) {
  const text = String(value ?? "").trim();
  const parsed = text ? Number(text) : Number.NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.trunc(parsed));
}

/** 一条都没有时也算 1 页，免得页码显示成「第 1 / 0 页」。 */
export function pageCount(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

/** 代理端和后台的分页条共用这一句，两边文案不会再各写各的。 */
export function pageLabel(total: number, page: number, pageSize: number) {
  return `共 ${Math.max(0, total)} 条，第 ${page} / ${pageCount(total, pageSize)} 页`;
}

export function hasNextPage(total: number, page: number, pageSize: number) {
  return page * pageSize < total;
}
