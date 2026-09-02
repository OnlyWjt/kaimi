import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { cardplatformAccounts } from "@/db/schema";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import {
  listCardplatformAccounts,
  normalizeSiteBase,
  presentCardplatformAccount,
} from "@/lib/cardplatform/accounts";
import { normalizeCardplatformProtocol } from "@/lib/cardplatform/protocol";
import { bootDb } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { getPublicBaseUrl } from "@/lib/public-url";

const schema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(64),
  protocol: z
    .enum(["legacy", "spacexcard-legacy", "avanfinity", "avanfinity-2026-08"])
    .default("spacexcard-legacy"),
  siteBase: z.string().trim().url(),
  apiKey: z.string().trim().max(256).optional(),
  webhookSecret: z.string().trim().max(256).optional(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  priority: z.number().int().min(1).max(999).optional(),
});

export async function GET(req: Request) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const origin = await getPublicBaseUrl(req);
  const rows = await listCardplatformAccounts();
  return NextResponse.json({
    list: rows.map((row) => presentCardplatformAccount(row, origin)),
    webhookBase: `${origin}/api/v1/webhooks/cardplatform`,
  });
}

export async function POST(req: Request) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const details = [
      ...flat.formErrors,
      ...Object.entries(flat.fieldErrors).flatMap(([key, value]) =>
        (value || []).map((item) => `${key}: ${item}`),
      ),
    ].join("；");
    return NextResponse.json(
      { error: details || "请检查卡台地址和必填项", details: flat },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const normalizedBase = normalizeSiteBase(data.siteBase);
  const protocol = normalizeCardplatformProtocol(data.protocol);
  const now = new Date().toISOString();
  const origin = await getPublicBaseUrl(req);

  try {
    const account = await db.transaction(async (tx) => {
      if (data.isDefault) {
        await tx
          .update(cardplatformAccounts)
          .set({ isDefault: false, updatedAt: now });
      }
      if (data.id) {
        const existing = await tx.query.cardplatformAccounts.findFirst({
          where: eq(cardplatformAccounts.id, data.id),
        });
        if (!existing) throw new Error("卡台账户不存在");
        const [updated] = await tx
          .update(cardplatformAccounts)
          .set({
            name: data.name,
            protocol,
            siteBase: normalizedBase,
            enabled: data.enabled,
            isDefault: data.isDefault,
            priority: data.priority ?? existing.priority,
            ...(data.apiKey
              ? { apiKeyEncrypted: encryptSecret(data.apiKey) }
              : {}),
            ...(data.webhookSecret
              ? { webhookSecretEncrypted: encryptSecret(data.webhookSecret) }
              : {}),
            updatedAt: now,
          })
          .where(eq(cardplatformAccounts.id, data.id))
          .returning();
        return updated;
      }
      if (!data.apiKey) throw new Error("新建卡台账户必须填写 API Key");
      const existingCount = await tx.query.cardplatformAccounts.findMany();
      const [created] = await tx
        .insert(cardplatformAccounts)
        .values({
          name: data.name,
          protocol,
          siteBase: normalizedBase,
          apiKeyEncrypted: encryptSecret(data.apiKey),
          webhookSecretEncrypted: data.webhookSecret
            ? encryptSecret(data.webhookSecret)
            : "",
          enabled: data.enabled,
          isDefault: data.isDefault || existingCount.length === 0,
          priority: data.priority ?? 100,
        })
        .returning();
      return created;
    });
    if (!account) throw new Error("保存卡台失败");
    await writeAuditLog({
      actor: auth.session,
      action: data.id ? "admin.cardplatform.update" : "admin.cardplatform.create",
      targetType: "cardplatform_account",
      targetId: account.id,
      metadata: {
        name: data.name,
        siteBase: normalizedBase,
        enabled: data.enabled,
        protocol,
      },
    });
    return NextResponse.json({
      account: presentCardplatformAccount(account, origin),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存卡台失败" },
      { status: 400 },
    );
  }
}
