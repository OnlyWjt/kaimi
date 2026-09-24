import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openFail, openOk } from "@/lib/open-api/respond";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiKey(req, "cdks:reveal");
  if (!isApiKeyContext(auth)) return auth;
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return openFail("VALIDATION_FAILED", "卡密 ID 无效");
  const filters = [eq(issuedCdks.id, id)];
  if (auth.ownerType === "agent" && auth.agentId) {
    filters.push(eq(issuedCdks.agentId, auth.agentId));
  }
  const row = await db.query.issuedCdks.findFirst({ where: and(...filters) });
  if (!row) return openFail("NOT_FOUND", "卡密不存在");
  let code = "";
  try {
    code = decryptSecret(row.codeEncrypted);
  } catch {
    return openFail("INTERNAL", "卡密无法读取");
  }
  await writeAuditLog({
    action: "open_api_cdk_reveal",
    targetType: "issued_cdk",
    targetId: row.id,
    ip: auth.ip,
    metadata: { keyId: auth.id, agentId: auth.agentId },
  });
  return openOk({ id: row.id, code, status: row.status });
}
