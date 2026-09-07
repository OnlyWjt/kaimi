import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  beginRechargeOrder,
  driveOpenedRecharge,
  RedeemInFlightError,
} from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { checkChatGPTSessionLocal } from "@/lib/session-check";

const schema = z.object({
  code: z.string().min(6),
  email: z.string().optional().default(""),
  session: z.string().optional().default(""),
  password: z.string().optional().default(""),
  mode: z.enum(["session", "mailbox"]).optional().default("session"),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-cdk-redeem", 8);
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    const mailbox = body.mode === "mailbox";
    const code = body.code.trim();
    let email = body.email.trim();
    if (mailbox && !email) {
      return NextResponse.json({ error: "请填写账号邮箱" }, { status: 400 });
    }
    if (!mailbox) {
      const local = checkChatGPTSessionLocal(body.session);
      if (!local.ok) {
        return NextResponse.json(
          { error: local.errors[0] || "Session 无效" },
          { status: 400 },
        );
      }
      email = (local.email || email).trim();
    }
    const account = mailbox
      ? {
          mode: "mailbox" as const,
          email,
          password: body.password,
          email_password: body.password,
        }
      : {
          mode: "session" as const,
          session: body.session,
          email,
        };

    try {
      const opened = await beginRechargeOrder({
        cdkCode: code,
        email,
        account,
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "兑换失败" },
      { status: 400 },
    );
  }
}
