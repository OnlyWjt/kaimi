import fs from "node:fs";
import path from "node:path";
import { client, databaseFilePath } from "@/db";
import { backupFileName, backupsToDelete, latestBackupAt, sqlStringLiteral } from "@/lib/db-backup-core";

/** 两次备份至少隔这么久。频繁重启部署时不会一天备很多份、把前几天的挤掉。 */
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * 每天把库做一份一致快照。用 VACUUM INTO 而不是 cp：WAL 模式下直接拷文件会丢掉还在 -wal 里的写入。
 *
 * 默认写到库文件旁边的 backups/，防的是误操作和坏迁移，挡不住整块盘没了；
 * 要异地备份，把 KAIMI_BACKUP_DIR 指到另一块盘或挂载的对象存储，再由宿主机同步走。
 */
export async function backupDatabase(now = new Date()) {
  if (!databaseFilePath) return { skipped: "不是本地 SQLite 文件" as const };
  const dir = process.env.KAIMI_BACKUP_DIR?.trim() || path.join(path.dirname(databaseFilePath), "backups");
  const keep = Math.max(1, Number(process.env.KAIMI_BACKUP_KEEP || 7) || 7);
  fs.mkdirSync(dir, { recursive: true });
  const latest = latestBackupAt(fs.readdirSync(dir));
  if (latest && now.getTime() - latest.getTime() < MIN_INTERVAL_MS) {
    return { skipped: "距上次备份不到 20 小时" as const };
  }
  const target = path.join(dir, backupFileName(now)).replace(/\\/g, "/");
  await client.execute(`VACUUM INTO ${sqlStringLiteral(target)}`);
  const removed = backupsToDelete(fs.readdirSync(dir), keep);
  for (const name of removed) fs.rmSync(path.join(dir, name), { force: true });
  return { file: target, removed: removed.length };
}
