import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import { getCardplatformAccountOrThrow } from "@/lib/cardplatform/accounts";
import { getCardplatformClientById } from "@/lib/cardplatform/config";
import {
  firstUsableCardPref,
  listCachedProducts,
  listSelectionRules,
  loadSiteRedeemPolicy,
  saveSiteRedeemPolicy,
  syncOwnerDirectCardRules,
} from "@/lib/cardplatform/policy";
import { bootDb } from "@/lib/config";

const schema = z.object({
  enabled: z.boolean(),
  noAutoCardSwitch: z.boolean(),
  strictCardPreference: z.boolean(),
  autoOpenWhenNoCard: z.boolean(),
  maxNewAccountsPerCard: z.number().int().min(1).max(20),
  maxCardsPerTask: z.number().int().min(1).max(20),
  failCooldownHours: z.number().int().min(0).max(168),
  issuingArea: z.string().trim().max(64),
  holderFirst: z.string().trim().max(32),
  holderLast: z.string().trim().max(32),
});

async function payload(accountId: number) {
  const [policy, rules, products] = await Promise.all([
    loadSiteRedeemPolicy(accountId),
    listSelectionRules(accountId),
    listCachedProducts(accountId),
  ]);
  return {
    accountId,
    policy,
    resolvedPref: firstUsableCardPref(policy, rules, products),
  };
}

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
    return NextResponse.json(await payload(id));
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
    const current = await loadSiteRedeemPolicy(id);
    const policy = await saveSiteRedeemPolicy(id, {
      ...current,
      ...parsed.data,
      productCode: "",
      issuer: "",
    });
    let cardplatformOk = true;
    let cardplatformErr = "";
    try {
      const { client } = await getCardplatformClientById(id, {
        allowDisabled: true,
      });
      await syncOwnerDirectCardRules(client, id);
    } catch (error) {
      cardplatformOk = false;
      cardplatformErr = error instanceof Error ? error.message : String(error);
    }
    await writeAuditLog({
      actor: auth.session,
      action: "admin.cardplatform.policy",
      targetType: "cardplatform_account",
      targetId: id,
      metadata: { enabled: policy.enabled, cardplatformOk },
    });
    return NextResponse.json({
      ...(await payload(id)),
      cardplatformOk,
      cardplatformErr,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败" },
      { status: 400 },
    );
  }
}
