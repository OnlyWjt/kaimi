import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentDrawItems, agentDrawOrders, issuedCdks } from "@/db/schema";
import { createDrawOrder, DrawError, listAgentDrawOrders } from "@/lib/agent-draw";
import { decryptSecret } from "@/lib/crypto";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { agentDrawAccessStatus } from "@/lib/open-api/draw-access";
import { openFail, openOk } from "@/lib/open-api/respond";

const schema = z.object({
  plan_key: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive(),
  region_confirmed: z.boolean().optional(),
});

function failFromDraw(error: unknown) {
  if (error instanceof DrawError) {
    if (error.status === 404) return openFail("NOT_FOUND", error.message);
    if (error.status === 409) return openFail("CONFLICT", error.message);
    if (error.status === 403) return openFail("FORBIDDEN_SCOPE", error.message);
    return openFail("VALIDATION_FAILED", error.message);
  }
  return openFail("VALIDATION_FAILED", error instanceof Error ? error.message : "提卡失败");
}

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "draw:read");
  if (!isApiKeyContext(auth)) return auth;
  if (auth.ownerType !== "agent" || !auth.agentId) {
    return openFail("FORBIDDEN_SCOPE", "只有代理 Key 可以查提卡");
  }
  const status = await agentDrawAccessStatus(auth.agentId);
  if (status !== "approved" && status !== "suspended") {
    return openFail("FORBIDDEN_SCOPE", "还没有提卡权限");
  }
  const rows = await listAgentDrawOrders(auth.agentId);
  return openOk({
    draws: rows.map((row) => ({
      draw_no: row.drawNo,
      status: row.status,
      plan_name: row.planName,
      quantity: row.quantity,
      issued_count: row.issuedCount,
      unit_price_cents: row.unitPriceCents,
      amount_cents: row.unitPriceCents * row.issuedCount,
      created_at: row.createdAt,
      message: row.lastErrorMessage || "",
    })),
  });
}

export async function POST(req: Request) {
  const auth = await requireApiKey(req, "draw:write");
  if (!isApiKeyContext(auth)) return auth;
  if (auth.ownerType !== "agent" || !auth.agentId) {
    return openFail("FORBIDDEN_SCOPE", "只有代理 Key 可以提卡");
  }
  const idemKey = req.headers.get("idempotency-key")?.trim() || "";
  if (idemKey.length < 8 || idemKey.length > 80) {
    return openFail("VALIDATION_FAILED", "Idempotency-Key 需要 8 到 80 个字符");
  }
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return openFail("VALIDATION_FAILED", "提卡参数无效");
  }
  try {
    const result = await createDrawOrder(auth.agentId, {
      requestId: idemKey,
      planKey: body.plan_key,
      quantity: body.quantity,
      regionConfirmed: body.region_confirmed,
    });
    const order = await db.query.agentDrawOrders.findFirst({
      where: and(eq(agentDrawOrders.agentId, auth.agentId), eq(agentDrawOrders.drawNo, result.drawNo)),
    });
    const cards = order
      ? await db
          .select({
            id: agentDrawItems.id,
            codeEncrypted: issuedCdks.codeEncrypted,
          })
          .from(agentDrawItems)
          .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
          .where(and(eq(agentDrawItems.drawOrderId, order.id), ne(agentDrawItems.status, "void")))
      : [];
    return openOk({
        draw_no: result.drawNo,
        status: result.status,
        plan_name: result.planName,
        quantity: result.quantity,
        issued_count: result.issuedCount,
        unit_price_cents: result.unitPriceCents,
        amount_cents: result.amountCents,
        message: result.message || "",
        credit: {
          limit_cents: result.credit.limitCents,
          exposure_cents: result.credit.exposureCents,
          available_cents: result.credit.availableCents,
        },
        items: cards.map((card) => ({ id: card.id, code: decryptSecret(card.codeEncrypted) })),
    });
  } catch (error) {
    return failFromDraw(error);
  }
}
