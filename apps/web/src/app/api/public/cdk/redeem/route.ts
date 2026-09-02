import { NextResponse } from "next/server";
import { z } from "zod";
import { createRechargeOrder } from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";

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
    const email = body.email.trim();
    if (mailbox && !email) {
      return NextResponse.json({ error: "请填写账号邮箱" }, { status: 400 });
    }
    const order = await createRechargeOrder({
      cdkCode: body.code.trim(),
      email,
      account: mailbox
        ? {
            mode: "mailbox",
            email,
            password: body.password,
            email_password: body.password,
          }
        : {
            mode: "session",
            session: body.session,
            email,
          },
    });
    return NextResponse.json({
      orderNo: order.orderNo,
      status: order.fulfillStatus,
      message: order.message,
      request_id: order.upstreamRequestId,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "兑换失败" },
      { status: 400 },
    );
  }
}
