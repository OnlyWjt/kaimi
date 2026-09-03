import { NextResponse } from "next/server";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import { getCardplatformAccountOrThrow } from "@/lib/cardplatform/accounts";
import { listCachedProducts } from "@/lib/cardplatform/policy";
import { syncAccountProducts } from "@/lib/cardplatform/products";
import { bootDb } from "@/lib/config";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "无效账户" }, { status: 400 });
  }
  try {
    await getCardplatformAccountOrThrow(id);
    const synced = await syncAccountProducts(id);
    const products = await listCachedProducts(id);
    await writeAuditLog({
      actor: auth.session,
      action: "admin.cardplatform.sync_products",
      targetType: "cardplatform_account",
      targetId: id,
      metadata: synced,
    });
    return NextResponse.json({ ...synced, products });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "同步失败" },
      { status: 502 },
    );
  }
}
