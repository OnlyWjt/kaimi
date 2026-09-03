import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts, issuedCdks } from "@/db/schema";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import {
  getCardplatformAccountOrThrow,
  presentCardplatformAccount,
} from "@/lib/cardplatform/accounts";
import { bootDb } from "@/lib/config";
import { getPublicBaseUrl } from "@/lib/public-url";

function accountId(params: { id: string }) {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return 0;
  return id;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const id = accountId(await params);
  if (!id) return NextResponse.json({ error: "无效账户" }, { status: 400 });
  try {
    const account = await getCardplatformAccountOrThrow(id);
    return NextResponse.json({
      account: presentCardplatformAccount(account, await getPublicBaseUrl(req)),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取失败" },
      { status: 404 },
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const id = accountId(await params);
  if (!id) return NextResponse.json({ error: "无效账户" }, { status: 400 });
  const issued = await db.query.issuedCdks.findFirst({
    where: eq(issuedCdks.cardplatformAccountId, id),
  });
  if (issued) {
    return NextResponse.json(
      { error: "该账户已发出过卡密，只能停用，不能删除" },
      { status: 409 },
    );
  }
  await db.delete(cardplatformAccounts).where(eq(cardplatformAccounts.id, id));
  await writeAuditLog({
    actor: auth.session,
    action: "admin.cardplatform.delete",
    targetType: "cardplatform_account",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
