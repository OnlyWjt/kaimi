import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  beginRechargeOrder,
  driveOpenedRecharge,
  RedeemInFlightError,
} from "@/lib/orders";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";
import { recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { checkChatGPTSessionLocal } from "@/lib/session-check";
import { publicErrorMessage } from "@/lib/public-error";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";
import { MAILBOX_REDEEM_REMOVED, type AgentCredential } from "@/lib/recharge-types";

const schema = z.object({
  code: z.string().min(REDEEM_CODE_MIN_LENGTH),
  email: z.string().optional().default(""),
  session: z.string().optional().default(""),
  mode: z.string().optional().default("session"),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-cdk-redeem", 8);
  if (limited) return limited;
  const ip = clientIp(req);
  const blocked = await redeemBlockResponse({ ip });
  if (blocked) return blocked;
  let contactEmail = "";
  try {
    const body = schema.parse(await req.json());
    if (body.mode !== "session") {
      return NextResponse.json({ error: MAILBOX_REDEEM_REMOVED }, { status: 400 });
    }
    const code = body.code.trim();
    const local = checkChatGPTSessionLocal(body.session);
    if (!local.ok) {
      return NextResponse.json(
        { error: local.errors[0] || "Session 无效" },
        { status: 400 },
      );
    }
    const email = (local.email || body.email).trim();
    contactEmail = email;
    const account: AgentCredential = {
      mode: "session",
      session: body.session,
      email,
    };

    try {
      const opened = await beginRechargeOrder({
        cdkCode: code,
        email,
        account,
        clientIp: ip,
      });
      after(() => driveOpenedRecharge({ opened, code, account }));
      return NextResponse.json({
        orderNo: opened.order.orderNo,
        status: opened.order.fulfillStatus,
        message: opened.order.message || "已提交，正在开通",
        request_id: opened.order.upstreamRequestId,
      });
    } catch (error) {
      if (error instanceof RedeemInFlightError && error.orderNo) {
        return NextResponse.json({
          orderNo: error.orderNo,
          status: "pending",
          message: error.message,
          request_id: "",
        });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof RedeemRejectedError) {
      await recordRedeemFailure({
        ip,
        email: contactEmail,
        outcome: error.outcome,
        route: "public-cdk-redeem",
      });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: publicErrorMessage(error, "兑换失败", "public/cdk/redeem") },
      { status: 400 },
    );
  }
}
