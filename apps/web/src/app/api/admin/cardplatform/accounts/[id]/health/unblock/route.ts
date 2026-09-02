import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import { getCardplatformAccountOrThrow } from "@/lib/cardplatform/accounts";
import { listActiveBlocklist, unblockCard } from "@/lib/cardplatform/health";
import { bootDb } from "@/lib/config";

const schema = z.object({
  cardId: z.number().int().positive(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "无效账户" }, { status: 400 });
  }
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    await getCardplatformAccountOrThrow(id);
    await unblockCard(id, parsed.data.cardId);
    await writeAuditLog({
      actor: auth.session,
      action: "admin.cardplatform.unblock",
      targetType: "cardplatform_account",
      targetId: id,
      metadata: { cardId: parsed.data.cardId },
    });
    return NextResponse.json({
      ok: true,
      blocklist: await listActiveBlocklist(id),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "解黑失败" },
      { status: 400 },
    );
  }
}
