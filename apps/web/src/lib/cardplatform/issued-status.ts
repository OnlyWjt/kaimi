import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks } from "@/db/schema";

/** 上游 CDK 生命周期 → 本站 issued_cdks.status；空串表示不动这一行。 */
export function mapUpstreamCdkStatus(raw: string) {
  const status = raw.trim().toLowerCase();
  if (status === "consumed" || status === "used") return "used";
  if (status === "disabled") return "disabled";
  if (status === "unused") return "unused";
  return "";
}

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
  if (!row || row.status === mapped) return false;
  // 已核销或已禁用的卡不许退回可售。
  if (mapped === "unused" && (row.status === "used" || row.status === "disabled")) {
    return false;
  }

  const now = new Date().toISOString();
  await db
    .update(issuedCdks)
    .set({
      status: mapped,
      usedAt: mapped === "used" ? row.usedAt || now : row.usedAt,
      updatedAt: now,
    })
    .where(eq(issuedCdks.id, row.id));
  return true;
}
