import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "卡密 ID 无效" }, { status: 400 });
  }
  const cdk = await db.query.issuedCdks.findFirst({
    where: and(
      eq(issuedCdks.id, id),
      eq(issuedCdks.agentId, session.agentId),
    ),
  });
  if (!cdk) return NextResponse.json({ error: "卡密不存在" }, { status: 404 });
  await writeAuditLog({
    actor: session,
    action: "agent.cdk.reveal",
    targetType: "issued_cdk",
    targetId: cdk.id,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
  });
  return NextResponse.json({ code: decryptSecret(cdk.codeEncrypted) });
}
