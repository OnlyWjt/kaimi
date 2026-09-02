import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import { getCardplatformAccountOrThrow } from "@/lib/cardplatform/accounts";
import {
  listActiveBlocklist,
  loadCardHealthPolicy,
  saveCardHealthPolicy,
} from "@/lib/cardplatform/health";
import { bootDb } from "@/lib/config";

const schema = z.object({
  enabled: z.boolean(),
  failThreshold: z.number().int().min(1).max(20),
  freezeOnBlock: z.boolean(),
  requireKnownEmail: z.boolean(),
});

export async function GET(
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
    const [policy, blocklist] = await Promise.all([
      loadCardHealthPolicy(id),
      listActiveBlocklist(id),
    ]);
    return NextResponse.json({ accountId: id, policy, blocklist });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取失败" },
      { status: 400 },
    );
  }
}

export async function PUT(
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
    const policy = await saveCardHealthPolicy(id, parsed.data);
    const blocklist = await listActiveBlocklist(id);
    await writeAuditLog({
      actor: auth.session,
      action: "admin.cardplatform.health",
      targetType: "cardplatform_account",
      targetId: id,
      metadata: policy,
    });
    return NextResponse.json({ accountId: id, policy, blocklist });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败" },
      { status: 400 },
    );
  }
}
