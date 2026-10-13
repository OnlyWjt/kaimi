import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

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
/** 本地库文件的绝对路径；远程 libsql 时为空串。备份用。 */
export const databaseFilePath = resolvedUrl.startsWith("file:") ? resolvedUrl.slice("file:".length) : "";
export const db = drizzle(client, { schema });
export { client };
