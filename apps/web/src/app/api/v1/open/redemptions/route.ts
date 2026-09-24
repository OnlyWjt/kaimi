import { after, NextResponse } from "next/server";
import { z } from "zod";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";
import {
  beginRechargeOrder,
  driveOpenedRecharge,
  RedeemInFlightError,
} from "@/lib/orders";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { claimIdempotent, storeIdempotent } from "@/lib/open-api/idempotency";
import { openFail, openOk } from "@/lib/open-api/respond";
import { recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";
import { checkChatGPTSessionLocal } from "@/lib/session-check";

const schema = z.object({
  code: z.string().min(6),
  mode: z.enum(["session", "mailbox"]).default("session"),
  session: z.string().optional().default(""),
  email: z.string().optional().default(""),
  password: z.string().optional().default(""),
});

export async function POST(req: Request) {
  const auth = await requireApiKey(req, "redeem:write");
  if (!isApiKeyContext(auth)) return auth;
  const subject = `key:${auth.id}`;
  const blocked = await redeemBlockResponse({ ip: subject });
  if (blocked) return openFail("REDEEM_BLOCKED", "兑换失败过多，请稍后再试");
  const idemKey = req.headers.get("idempotency-key")?.trim() || "";
  const raw = await req.text();
  const idem = idemKey
    ? await claimIdempotent({ keyId: auth.id, idemKey, body: raw })
    : null;
  if (idem?.replay) return idem.replay;
  const finish = async (response: NextResponse) => {
    if (idemKey && idem) {
      await storeIdempotent({
        keyId: auth.id,
        idemKey,
        requestHash: idem.requestHash,
        status: response.status,
        responseJson: await response.clone().text(),
      });
    }
    return response;
  };
  try {
    const body = schema.parse(JSON.parse(raw || "{}"));
    if (auth.ownerType === "agent") {
      const issued = await findIssuedCdkByCode(body.code);
      if (!issued || issued.agentId !== auth.agentId) {
        await recordRedeemFailure({
          ip: subject,
          outcome: "unknown_code",
          route: "open-redemptions",
        });
        return finish(openFail("CDK_INVALID", "卡密无效或已使用"));
      }
    }
    let email = body.email.trim();
    if (body.mode === "session") {
      const local = checkChatGPTSessionLocal(body.session);
      if (!local.ok) return finish(openFail("VALIDATION_FAILED", local.errors[0] || "Session 无效"));
      email = (local.email || email).trim();
    } else if (!email) {
      return finish(openFail("VALIDATION_FAILED", "请填写账号邮箱"));
    }
    const account =
      body.mode === "mailbox"
        ? { mode: "mailbox" as const, email, password: body.password, email_password: body.password }
        : { mode: "session" as const, session: body.session, email };
    const opened = await beginRechargeOrder({
      cdkCode: body.code.trim(),
      email,
      account,
      clientIp: auth.ip,
      source: `api:${auth.id}`,
    });
    after(() => driveOpenedRecharge({ opened, code: body.code.trim(), account }));
    return finish(openOk({
      redemption_no: opened.order.orderNo,
      status: opened.order.fulfillStatus,
    }));
  } catch (error) {
    if (error instanceof RedeemRejectedError) {
      await recordRedeemFailure({
        ip: subject,
        outcome: error.outcome,
        route: "open-redemptions",
      });
      return finish(openFail("CDK_INVALID", error.message));
    }
    if (error instanceof RedeemInFlightError) {
      return finish(openOk({ redemption_no: error.orderNo, status: "pending", message: error.message }));
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return finish(openFail("VALIDATION_FAILED", error instanceof z.ZodError ? error.issues[0]?.message || "参数无效" : "请求体不是 JSON"));
    }
    return finish(openFail("INTERNAL", error instanceof Error ? error.message : "兑换失败"));
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
