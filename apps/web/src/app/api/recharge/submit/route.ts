import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  beginRechargeOrder,
  driveOpenedRecharge,
  RedeemInFlightError,
} from "@/lib/orders";
import { MAILBOX_REDEEM_REMOVED, type AgentCredential } from "@/lib/recharge-types";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";
import { checkChatGPTSessionLocal } from "@/lib/session-check";
import { publicErrorMessage } from "@/lib/public-error";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";

const schema = z
  .object({
    code: z.string().min(REDEEM_CODE_MIN_LENGTH),
    email: z.string().email().optional().or(z.literal("")),
    mode: z.string().optional().default("session"),
    session: z.string().optional().default(""),
    productId: z.number().int().positive().optional(),
    planKey: z.string().trim().optional(),
  })
  .superRefine((val, ctx) => {
    // mode 不对在 POST 里单独回话术，这里只核 Session。
    if (val.mode === "session" && (!val.session || val.session.trim().length < 8)) {
      ctx.addIssue({ code: "custom", path: ["session"], message: "请填写 Session" });
    }
  });

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "recharge-submit", 8);
  if (limited) return limited;
  const ip = clientIp(req);
  const blocked = await redeemBlockResponse({ ip });
  if (blocked) return blocked;

  try {
    const body = schema.parse(await req.json());
    if (body.mode !== "session") {
      return NextResponse.json({ error: MAILBOX_REDEEM_REMOVED }, { status: 400 });
    }
    const code = body.code.trim();

    // 提交前客户已经点过预检。这里只核本地格式，不再打卡台 preview/preflight，
    // 否则按钮会再堵一轮 45 秒。真正的预检在 after() 里 drive 时做。
    const local = checkChatGPTSessionLocal(body.session);
    if (!local.ok) {
      return NextResponse.json(
        {
          error: local.errors[0] || "Session 无效",
          errors: local.errors,
        },
        { status: 400 },
      );
    }
    const contactEmail = (local.email || body.email || "").trim();
    if (!contactEmail) {
      return NextResponse.json(
        { error: "Session 中未读到邮箱，请更换账号后再试" },
        { status: 400 },
      );
    }
    const account: AgentCredential = {
      mode: "session",
      session: body.session.trim(),
      email: contactEmail,
    };

    try {
      const opened = await beginRechargeOrder({
        cdkCode: code,
        email: contactEmail,
        account,
        planKey: body.planKey,
        clientIp: ip,
      });
      after(() =>
        driveOpenedRecharge({ opened, code, account }),
      );
      return NextResponse.json({
        orderNo: opened.order.orderNo,
        payStatus: opened.order.payStatus,
        fulfillStatus: opened.order.fulfillStatus,
        message: opened.order.message || "已提交，正在开通",
        requestId: opened.order.upstreamRequestId,
      });
    } catch (error) {
      if (error instanceof RedeemInFlightError && error.orderNo) {
        return NextResponse.json({
          orderNo: error.orderNo,
          payStatus: "manual",
          fulfillStatus: "pending",
          message: error.message,
          requestId: "",
        });
      }
      throw error;
    }
  } catch (err) {
    if (err instanceof RedeemRejectedError) {
      await recordRedeemFailure({
        ip,
        outcome: err.outcome,
        route: "recharge-submit",
      });
    }
    const message = publicErrorMessage(err, "提交失败", "recharge/submit");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
