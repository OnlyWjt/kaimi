import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { installWriteGuard } from "./write-guard";

const rawUrl = process.env.KAIMI_DATABASE_URL || "file:./data/kaimi.db";

function resolveFileUrl(url: string) {
  if (!url.startsWith("file:")) return url;
  const filePath = url.slice("file:".length);
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // libsql on Windows prefers forward slashes in file URLs
  return `file:${absolute.replace(/\\/g, "/")}`;
}

const resolvedUrl = resolveFileUrl(rawUrl);
const client = createClient({ url: resolvedUrl });
// 本地 sqlite：写在进程内排队，撞锁后重建连接，见 write-guard.ts。
const writeGuard = resolvedUrl.startsWith("file:") ? installWriteGuard(client) : null;
/** 本地库文件的绝对路径；远程 libsql 时为空串。备份用。 */
export const databaseFilePath = resolvedUrl.startsWith("file:") ? resolvedUrl.slice("file:".length) : "";
export const db = drizzle(client, { schema });
if (writeGuard) {
  const transaction = db.transaction.bind(db);
  db.transaction = ((callback, config) =>
    writeGuard.runTransaction(() => transaction(callback, config))) as typeof db.transaction;
}
export { client };
