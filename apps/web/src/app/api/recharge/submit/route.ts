import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  beginRechargeOrder,
  driveOpenedRecharge,
  RedeemInFlightError,
} from "@/lib/orders";
import type { AgentCredential } from "@/lib/recharge-types";
import { enforceRateLimit } from "@/lib/rate-limit";
import { checkChatGPTSessionLocal } from "@/lib/session-check";

const schema = z
  .object({
    code: z.string().min(6),
    email: z.string().email().optional().or(z.literal("")),
    mode: z.enum(["session", "mailbox"]).optional().default("session"),
    session: z.string().optional().default(""),
    password: z.string().optional().default(""),
    productId: z.number().int().positive().optional(),
    planKey: z.string().trim().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "mailbox") {
      if (!val.password || val.password.length < 4) {
        ctx.addIssue({ code: "custom", path: ["password"], message: "请填写邮箱密码" });
      }
    } else if (!val.session || val.session.trim().length < 8) {
      ctx.addIssue({ code: "custom", path: ["session"], message: "请填写 Session" });
    }
  });

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "recharge-submit", 8);
  if (limited) return limited;

  try {
    const body = schema.parse(await req.json());
    const code = body.code.trim();

    let contactEmail: string;
    let account: AgentCredential;

    if (body.mode === "mailbox") {
      contactEmail = String(body.email || "").trim();
      if (!contactEmail) {
        return NextResponse.json({ error: "请填写账号邮箱" }, { status: 400 });
      }
      account = {
        mode: "mailbox",
        email: contactEmail,
        password: body.password.trim(),
        email_password: body.password.trim(),
      };
    } else {
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
      contactEmail = (local.email || body.email || "").trim();
      if (!contactEmail) {
        return NextResponse.json(
          { error: "Session 中未读到邮箱，请更换账号后再试" },
          { status: 400 },
        );
      }
      account = {
        mode: "session",
        session: body.session.trim(),
        email: contactEmail,
      };
    }

    try {
      const opened = await beginRechargeOrder({
        cdkCode: code,
        email: contactEmail,
        account,
        planKey: body.planKey,
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
    const message = err instanceof Error ? err.message : "提交失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
