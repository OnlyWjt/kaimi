import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks } from "@/db/schema";
import {
  canApplyUpstreamCdkStatus,
  mapUpstreamCdkStatus,
} from "./issued-status-core";

export {
  canApplyUpstreamCdkStatus,
  mapUpstreamCdkStatus,
} from "./issued-status-core";

/** 回写一张已发卡密的状态。回调和对账轮询共用，重复投递不会改坏数据。 */
export async function applyIssuedCdkStatus(input: {
  cdkId: number;
  accountId: number;
  status: string;
}) {
  const { cdkId, accountId } = input;
  if (!Number.isSafeInteger(cdkId) || cdkId <= 0) return false;
  const mapped = mapUpstreamCdkStatus(input.status);
  if (!mapped) return false;

  const row = await db.query.issuedCdks.findFirst({
    where: and(
      eq(issuedCdks.upstreamRef, String(cdkId)),
      eq(issuedCdks.cardplatformAccountId, accountId),
    ),
  });
  if (!row) return false;
  if (!canApplyUpstreamCdkStatus(row.status, mapped)) return false;

  const now = new Date().toISOString();
  // 带上读到的旧状态做比较写：读完到写之间本地可能刚把这张卡抢成 locked，
  // 那一手必须赢，不能被这条回写覆盖掉。
  const updated = await db
    .update(issuedCdks)
    .set({
      status: mapped,
      usedAt: mapped === "used" ? row.usedAt || now : row.usedAt,
      updatedAt: now,
    })
    .where(and(eq(issuedCdks.id, row.id), eq(issuedCdks.status, row.status)))
    .returning();
  return updated.length > 0;
}
