import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdmin } from "@/lib/admin-guard";
import { writeAuditLog } from "@/lib/audit";
import { getCardplatformAccountOrThrow } from "@/lib/cardplatform/accounts";
import { getCardplatformClientById } from "@/lib/cardplatform/config";
import {
  cardProductUsable,
  firstUsableCardPref,
  listCachedProducts,
  listSelectionRules,
  loadSiteRedeemPolicy,
  replaceSelectionRules,
  syncOwnerDirectCardRules,
} from "@/lib/cardplatform/policy";
import { bootDb } from "@/lib/config";

const ruleSchema = z.object({
  planKey: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(64).optional().default(""),
  binPrefix: z.string().trim().max(32).optional().default(""),
  channel: z.string().trim().max(32).optional().default(""),
  enabled: z.boolean(),
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
    return NextResponse.json(await selectionPayload(id));
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
  const parsed = z.object({ rules: z.array(ruleSchema) }).safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    await getCardplatformAccountOrThrow(id);
    await replaceSelectionRules(
      id,
      parsed.data.rules.map((rule) => ({
        planKey: rule.planKey,
        displayName: rule.displayName || rule.planKey,
        binPrefix: rule.binPrefix,
        channel: rule.channel,
        enabled: rule.enabled,
      })),
    );
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
      action: "admin.cardplatform.selection",
      targetType: "cardplatform_account",
      targetId: id,
      metadata: { count: parsed.data.rules.length, cardplatformOk },
    });
    return NextResponse.json({
      ...(await selectionPayload(id)),
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

async function selectionPayload(accountId: number) {
  const [rules, products, policy] = await Promise.all([
    listSelectionRules(accountId),
    listCachedProducts(accountId),
    loadSiteRedeemPolicy(accountId),
  ]);
  const lastSync =
    products.reduce((latest, item) => {
      return !latest || item.syncedAt > latest ? item.syncedAt : latest;
    }, "") || "";
  return {
    accountId,
    rules: rules.map((rule) => ({
      ...rule,
      online: cardProductUsable(rule.planKey, products),
    })),
    products,
    lastSync,
    resolvedPref: firstUsableCardPref(policy, rules, products),
  };
}
