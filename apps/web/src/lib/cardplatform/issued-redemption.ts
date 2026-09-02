import { eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks } from "@/db/schema";
import { decryptSecret, hashLookupValue } from "@/lib/crypto";
import { getCardplatformClientById } from "./config";

export function nestedString(
  payload: Record<string, unknown>,
  ...keys: string[]
) {
  const sources = [
    payload,
    typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : {},
  ];
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
  }
  return "";
}

export function cardplatformMessage(payload: Record<string, unknown>) {
  return (
    nestedString(payload, "message", "msg", "error_description", "error") ||
    "卡台兑换请求失败"
  );
}

export async function findIssuedCdkByCode(code: string) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const row = await db.query.issuedCdks.findFirst({
    where: eq(issuedCdks.codeHash, hashLookupValue(normalized)),
  });
  if (!row) return null;
  const plain = decryptSecret(row.codeEncrypted);
  return plain.trim().toUpperCase() === normalized ? { ...row, code: plain } : null;
}

export async function previewIssuedCdk(code: string) {
  const issued = await findIssuedCdkByCode(code);
  if (!issued) return null;
  if (issued.status === "used") throw new Error("该卡密已使用");
  if (issued.status === "locked" || issued.status === "redeeming") {
    throw new Error("该卡密兑换处理中，请稍后查询");
  }
  if (issued.status === "disabled") throw new Error("该卡密已禁用");
  const { client } = await getCardplatformClientById(
    issued.cardplatformAccountId,
    { allowDisabled: true },
  );
  const result = await client.previewCdk(issued.code);
  if (!result.ok) throw new Error(cardplatformMessage(result.payload));
  return { issued, preview: result.payload };
}
