import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { cardplatformAccounts } from "@/db/schema";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import {
  getCardplatformAccountOrThrow,
  listCardplatformAccounts,
  presentCardplatformAccount,
} from "@/lib/cardplatform/accounts";
import {
  defaultAccountWebhookPath,
  normalizeAccountWebhookPath,
} from "@/lib/cardplatform/urls";
import { bootDb } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { getPublicBaseUrl } from "@/lib/public-url";

const schema = z.object({
  webhookUrl: z.string().trim().max(512).optional(),
  webhookSecret: z.string().trim().max(256).optional(),
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
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (parsed.data.webhookUrl !== undefined) {
      const path = normalizeAccountWebhookPath(parsed.data.webhookUrl);
      const others = await listCardplatformAccounts();
      for (const other of others) {
        if (other.id === id) continue;
        const stored =
          other.webhookPath.trim().replace(/\/+$/, "") ||
          defaultAccountWebhookPath(other.id);
        if (stored === path) {
          throw new Error("该回调路径已被其他卡台账户占用");
        }
      }
      patch.webhookPath =
        path === defaultAccountWebhookPath(id) ? "" : path;
    }
    if (parsed.data.webhookSecret) {
      patch.webhookSecretEncrypted = encryptSecret(parsed.data.webhookSecret);
    }
    const [updated] = await db
      .update(cardplatformAccounts)
      .set(patch)
      .where(eq(cardplatformAccounts.id, id))
      .returning();
    await writeAuditLog({
      actor: auth.session,
      action: "admin.cardplatform.webhook",
      targetType: "cardplatform_account",
      targetId: id,
      metadata: {
        webhookUrl: Boolean(parsed.data.webhookUrl),
        webhookSecret: Boolean(parsed.data.webhookSecret),
      },
    });
    return NextResponse.json({
      account: presentCardplatformAccount(
        updated,
        await getPublicBaseUrl(req),
      ),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败" },
      { status: 400 },
    );
  }
}
