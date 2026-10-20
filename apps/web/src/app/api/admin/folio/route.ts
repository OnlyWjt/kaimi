import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb, setSetting } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import {
  FOLIO_BASE_URL_SETTING,
  FOLIO_CALLBACK_PATH,
  FOLIO_ENABLED_SETTING,
  FOLIO_SECRET_SETTING,
  folioSelfTest,
} from "@/lib/folio/core";
import { readFolioConfig } from "@/lib/folio/sign";
import { getCallbackBaseUrl } from "@/lib/public-url";

const saveSchema = z.object({
  action: z.literal("save"),
  enabled: z.boolean(),
  baseUrl: z.string().trim().max(300),
  /** 留空 = 不修改 */
  secret: z.string().trim().max(500).optional(),
});

async function snapshot(req: Request) {
  const [config, origin] = await Promise.all([readFolioConfig(), getCallbackBaseUrl(req)]);
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    secretConfigured: Boolean(config.secret),
    secretTail: config.secret ? config.secret.slice(-4) : "",
    // 复制到 Folio「业务对接」页
    businessBaseUrl: origin,
    callbackUrl: origin ? `${origin}${FOLIO_CALLBACK_PATH}` : "",
  };
}

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json(await snapshot(req));
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const body = await req.json().catch(() => ({}));
  if (body?.action === "self_test") {
    return NextResponse.json(folioSelfTest());
  }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Folio 设置不完整" }, { status: 400 });
  const baseUrl = parsed.data.baseUrl.replace(/\/+$/, "");
  if (baseUrl && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    return NextResponse.json({ error: "Folio 地址要以 http:// 或 https:// 开头" }, { status: 400 });
  }
  const secret = parsed.data.secret || "";
  if (secret && secret.length < 16) {
    return NextResponse.json({ error: "共用密钥太短，请用 Folio「业务对接」页生成的那串" }, { status: 400 });
  }
  const current = await readFolioConfig();
  if (parsed.data.enabled && (!baseUrl || !(secret || current.secret))) {
    return NextResponse.json({ error: "打开对接前先填 Folio 地址和共用密钥" }, { status: 400 });
  }
  await setSetting(FOLIO_BASE_URL_SETTING, baseUrl);
  if (secret) await setSetting(FOLIO_SECRET_SETTING, encryptSecret(secret));
  await setSetting(FOLIO_ENABLED_SETTING, parsed.data.enabled ? "1" : "0");
  await writeAuditLog({
    actor: session,
    action: "settings.folio.update",
    targetType: "settings",
    targetId: "folio",
    metadata: {
      enabled: parsed.data.enabled,
      baseUrl,
      secretChanged: Boolean(secret),
      wasEnabled: current.enabled,
    },
  });
  return NextResponse.json(await snapshot(req));
}
