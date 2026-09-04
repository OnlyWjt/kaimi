/** 上游 CDK 生命周期 → 本站 issued_cdks.status；空串表示不动这一行。 */
export function mapUpstreamCdkStatus(raw: string) {
  const status = raw.trim().toLowerCase();
  if (status === "consumed" || status === "used") return "used";
  if (status === "disabled") return "disabled";
  if (status === "unused") return "unused";
  return "";
}

/**
 * 本站这一行还不许被上游的 unused 覆盖的状态。
 *
 * used / disabled：卡已经花掉或封掉了，退回可售就是白送。
 * locked / redeeming：本站正拿着这张卡在兑换。上游说 unused 只代表「卡台那边还没记到
 * 兑换」——review 中、回调早到、对账拉到的是兑换发起前的快照，都会这么说。真要退回可售，
 * `unused → locked` 的抢锁就能再成功一次，客户被扣第二次。
 *
 * 这里不区分「上游 unused 是因为我们压根没兑过」和「上游 unused 但我们持着锁」：本地锁
 * 只会由本地的终态路径解开（driveRechargeOrder 的失败分支、轮询拿到终态、以及
 * reconcileStuckLocks 兜底），上游在这件事上没有比本地更多的信息。
 */
const LOCAL_STATUS_OUTRANKS_UNUSED = new Set([
  "used",
  "disabled",
  "locked",
  "redeeming",
]);

/** 上游报来的状态能不能覆盖本地这一行。 */
export function canApplyUpstreamCdkStatus(
  localStatus: string,
  mappedStatus: string,
) {
  if (!mappedStatus || localStatus === mappedStatus) return false;
  if (mappedStatus !== "unused") return true;
  return !LOCAL_STATUS_OUTRANKS_UNUSED.has(localStatus);
}
