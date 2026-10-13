/** 备份文件名：kaimi-20261013-0300.db（UTC）。按名字排序就是按时间排序。 */
export function backupFileName(now: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `kaimi-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}.db`;
}

const BACKUP_NAME = /^kaimi-\d{8}-\d{4}\.db$/;

/** 保留最新的 keep 份，返回该删的文件名。不是本模块生成的文件一律不碰。 */
export function backupsToDelete(names: string[], keep: number) {
  const ours = names.filter((name) => BACKUP_NAME.test(name)).sort();
  return ours.slice(0, Math.max(0, ours.length - Math.max(1, keep)));
}

/** SQL 字符串字面量里的单引号要成对。 */
export function sqlStringLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 从文件名读出最近一份备份的时间。重启后靠它判断今天备份过没有，不依赖进程内状态。 */
export function latestBackupAt(names: string[]) {
  const latest = names.filter((name) => BACKUP_NAME.test(name)).sort().at(-1);
  if (!latest) return null;
  const m = /^kaimi-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.db$/.exec(latest)!;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}
