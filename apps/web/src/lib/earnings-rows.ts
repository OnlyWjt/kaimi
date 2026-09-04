/**
 * 收益导出的行聚合。
 *
 * 一单一张的年代里，明细行是 agent_earnings 左连 issued_cdks 出来的，靠
 * `issued_cdks_order_id_uq` 保证 1:1。一单多张之后那个唯一索引拆掉了，同一个连接会把
 * 5 张卡的订单摊成 5 行，而汇总是直接在这个数组上 reduce 的——毛收、成本、手续费、
 * 收益和订单数全部被乘上了张数。所以卡密信息现在走标量子查询，明细行严格一单一行，
 * 汇总只在这个数组上算。
 */

export type EarningDetailRow = {
  grossCents: number;
  costCents: number;
  estimatedFeeCents: number;
  actualFeeCents: number | null;
  earningCents: number;
  earningStatus: string;
};

export type EarningAdjustmentRow = {
  amountCents: number;
  status: string;
};

/**
 * 明细里的「卡密状态」。
 *
 * 一单多张时挑其中一张的状态是误导——5 张里 1 张已核销也会显示「已使用」。改成整单的
 * 核销进度，一单一张时读作「已使用 1/1」，含义不变。
 */
export function issuedCdkSummaryLabel(total: unknown, used: unknown) {
  const count = Math.max(0, Math.trunc(Number(total) || 0));
  if (count === 0) return "";
  const spent = Math.min(count, Math.max(0, Math.trunc(Number(used) || 0)));
  return `已使用 ${spent}/${count}`;
}

const PENDING_STATUSES = ["pending", "settling"];

/** 导出汇总页那一组数字。行必须是一单一行，否则这里的每一项都会被放大。 */
export function buildEarningsTotals(
  rows: EarningDetailRow[],
  adjustments: EarningAdjustmentRow[],
) {
  const sum = (pick: (row: EarningDetailRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const adjustmentCents = adjustments.reduce(
    (total, row) => total + row.amountCents,
    0,
  );
  return {
    orderCount: rows.length,
    grossCents: sum((row) => row.grossCents),
    costCents: sum((row) => row.costCents),
    estimatedFeeCents: sum((row) => row.estimatedFeeCents),
    actualFeeCents: sum((row) => row.actualFeeCents ?? 0),
    feeDifferenceCents: sum((row) =>
      row.actualFeeCents === null ? 0 : row.actualFeeCents - row.estimatedFeeCents,
    ),
    earningCents:
      sum((row) => (row.earningStatus === "reversed" ? 0 : row.earningCents)) +
      adjustmentCents,
    pendingCents:
      sum((row) =>
        PENDING_STATUSES.includes(row.earningStatus) ? row.earningCents : 0,
      ) +
      adjustments
        .filter((row) => PENDING_STATUSES.includes(row.status))
        .reduce((total, row) => total + row.amountCents, 0),
    settledCents:
      sum((row) => (row.earningStatus === "settled" ? row.earningCents : 0)) +
      adjustments
        .filter((row) => row.status === "settled")
        .reduce((total, row) => total + row.amountCents, 0),
    reversedCents: sum((row) =>
      row.earningStatus === "reversed" ? row.earningCents : 0,
    ),
    adjustmentCents,
  };
}
