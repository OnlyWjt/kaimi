import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getDefaultCardplatformAccount } from "@/lib/cardplatform/config";
import { syncDefaultCardplatformPlans } from "@/lib/cardplatform/plans";
import { supportsPaymentCountry } from "@/lib/cardplatform/protocol";
import {
  formatRegionWhitelist,
  paymentRegionsSettingKey,
  REGION_WHITELIST_SETTING,
} from "@/lib/cardplatform/regions";
import { getSetting, setSetting } from "@/lib/config";
import { writeAuditLog } from "@/lib/audit";

async function authorize() {
  try {
    return { session: await requireAdmin(), denied: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, denied: error };
    throw error;
  }
}

type CachedRegions = {
  syncedAt?: string;
  regions?: { country: string; currency: string }[];
};

export async function GET() {
  const { denied } = await authorize();
  if (denied) return denied;
  const account = await getDefaultCardplatformAccount();
  const accountId = account?.id ?? 0;
  const protocol = account?.protocol ?? "";
  const raw = await getSetting(paymentRegionsSettingKey(accountId), "");
  let cached: CachedRegions = {};
  try {
    cached = raw ? (JSON.parse(raw) as CachedRegions) : {};
  } catch {
    cached = {};
  }
  const whitelist = (await getSetting(REGION_WHITELIST_SETTING, "US,CL"))
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  return NextResponse.json({
    accountId,
    accountName: account?.name ?? "环境变量账户",
    protocolSupported: accountId === 0 || supportsPaymentCountry(protocol),
    syncedAt: cached.syncedAt ?? null,
    regions: Array.isArray(cached.regions) ? cached.regions : [],
    whitelist,
  });
}

const schema = z.object({
  whitelist: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).max(20),
});

export async function PUT(req: Request) {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "地区白名单格式无效" }, { status: 400 });
  }
  await setSetting(REGION_WHITELIST_SETTING, formatRegionWhitelist(parsed.data.whitelist));
  await writeAuditLog({
    actor: session,
    action: "admin.cardplatform.regions",
    targetType: "setting",
    metadata: { whitelist: parsed.data.whitelist },
  });
  try {
    const result = await syncDefaultCardplatformPlans();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: true,
        syncError: error instanceof Error ? error.message : "同步失败",
      },
      { status: 200 },
    );
  }
}
