import { NextResponse } from "next/server";
import { z } from "zod";
import { createRechargeOrder } from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifySessionForRedeem } from "@/lib/session-check";

const schema = z
  .object({
    code: z.string().min(6),
    email: z.string().email().optional().or(z.literal("")),
    mode: z.enum(["session", "mailbox"]).optional().default("session"),
    session: z.string().optional().default(""),
    password: z.string().optional().default(""),
    productId: z.number().int().positive().optional(),
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

    if (body.mode === "mailbox") {
      const mailboxEmail = String(body.email || "").trim();
      if (!mailboxEmail) {
        return NextResponse.json({ error: "请填写账号邮箱" }, { status: 400 });
      }
      const order = await createRechargeOrder({
        cdkCode: body.code.trim(),
        productId: body.productId,
        email: mailboxEmail,
        account: {
          mode: "mailbox",
          email: mailboxEmail,
          password: body.password.trim(),
          email_password: body.password.trim(),
        },
      });
      return NextResponse.json({
        orderNo: order.orderNo,
        payStatus: order.payStatus,
        fulfillStatus: order.fulfillStatus,
        message: order.message,
        requestId: order.upstreamRequestId,
      });
    }

    const sessionCheck = await verifySessionForRedeem(body.session, body.code);
    if (!sessionCheck.ok) {
      return NextResponse.json(
        {
          error: sessionCheck.errors[0] || "Session 无效",
          errors: sessionCheck.errors,
          error_code: sessionCheck.errorCode,
        },
        { status: 400 },
      );
    }

    const contactEmail = (sessionCheck.email || body.email || "").trim();
    if (!contactEmail) {
      return NextResponse.json({ error: "Session 中未读到邮箱，请更换账号后再试" }, { status: 400 });
    }

    const order = await createRechargeOrder({
      cdkCode: body.code.trim(),
      productId: body.productId,
      email: contactEmail,
      account: {
        mode: "session",
        session: body.session.trim(),
        email: contactEmail,
      },
    });

    return NextResponse.json({
      orderNo: order.orderNo,
      payStatus: order.payStatus,
      fulfillStatus: order.fulfillStatus,
      message: order.message,
      requestId: order.upstreamRequestId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "提交失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
