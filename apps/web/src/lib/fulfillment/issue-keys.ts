/**
 * 每次向卡台要卡都得带一个幂等键。整单要 N 张时，补发剩余的那次请求必须换键，
 * 否则卡台会把上一次的响应原样重放，永远拿不到剩下几张。
 *
 * 键按「已入库张数」派生：同一批剩余重试多少次都是同一个键（重放是安全的，
 * 拿回来的还是那几张已入库的卡），入库数一变就自然换成新键。
 * 结果未知（超时、网络中断）时不能靠这个键继续要卡，那种情况走人工核对。
 *
 * 另外要数「卡台明确回了空」的次数。那种响应是确定的（envelope.code 是 0，只是 issued
 * 为空），如果上游把这个空响应缓存在了这个键下面，不换键就是每次都拿回空，剩下的卡永远
 * 发不出来。只有这一种情况换键：超时之类的未知结果必须继续复用旧键，否则会真的多发一批。
 */
export function issueIdempotencyKey(
  baseKey: string,
  alreadyIssued: number,
  emptyResponses = 0,
) {
  const issued = Math.max(0, Math.trunc(alreadyIssued));
  const empties = Math.max(0, Math.trunc(emptyResponses));
  return [
    baseKey,
    issued > 0 ? `-r${issued}` : "",
    empties > 0 ? `-e${empties}` : "",
  ].join("");
}
