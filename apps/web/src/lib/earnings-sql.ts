import { sql, type SQLWrapper } from "drizzle-orm";

/**
 * 一单发出去几张卡、其中几张已核销。
 *
 * 用标量子查询而不是 `leftJoin(issuedCdks)`：一单多张之后那个连接会把一行明细摊成
 * N 行，汇总就是在这个数组上 reduce 的，毛收、成本、手续费、收益、订单数全都会被
 * 乘上张数；分页列表也会被一单吃掉 N 行。
 */
export function issuedCdkCountsFor(orderId: SQLWrapper) {
  return {
    cdkTotal: sql<number>`(
      select count(*) from issued_cdks where issued_cdks.order_id = ${orderId}
    )`,
    cdkUsed: sql<number>`(
      select count(*) from issued_cdks
      where issued_cdks.order_id = ${orderId} and issued_cdks.status = 'used'
    )`,
  };
}
