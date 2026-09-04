/**
 * 每次向卡台要卡都得带一个幂等键。整单要 N 张时，补发剩余的那次请求必须换键，
 * 否则卡台会把上一次的响应原样重放，永远拿不到剩下几张。
 *
 * 键按「已入库张数」派生：同一批剩余重试多少次都是同一个键（重放是安全的，
 * 拿回来的还是那几张已入库的卡），入库数一变就自然换成新键。
 * 结果未知（超时、网络中断）时不能靠这个键继续要卡，那种情况走人工核对。
 */
export function issueIdempotencyKey(baseKey: string, alreadyIssued: number) {
  const issued = Math.max(0, Math.trunc(alreadyIssued));
  return issued === 0 ? baseKey : `${baseKey}-r${issued}`;
}
