import { NextResponse } from "next/server";
import { z } from "zod";
import { preflightRedeemableCdk } from "@/lib/cardplatform/redeem";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  code: z.string().min(6),
  session: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  mode: z.enum(["session", "mailbox"]).optional().default("session"),
  credential: z
    .object({
      mode: z.enum(["session", "mailbox"]).optional(),
      session: z.string().optional(),
      email: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-cdk-preflight", 15);
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    const mode = body.credential?.mode || body.mode;
    const preflight = await preflightRedeemableCdk({
      code: body.code,
      account: {
        mode,
        session: body.credential?.session || body.session || "",
        email: body.credential?.email || body.email || "",
        password: body.credential?.password || body.password || "",
      },
    });
    return NextResponse.json({
      ...preflight.preflight,
      ok: true,
      email: preflight.accountEmail,
      redemption_token: preflight.redemptionToken,
      preflight_token: preflight.preflightToken,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "预检失败" },
      { status: 400 },
    );
  }
}
