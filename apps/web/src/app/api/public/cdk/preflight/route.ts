import { NextResponse } from "next/server";
import { z } from "zod";
import { preflightRedeemableCdk } from "@/lib/cardplatform/redeem";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { assertRedeemCodeKnown, recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";
import { publicErrorMessage } from "@/lib/public-error";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";
import { MAILBOX_REDEEM_REMOVED } from "@/lib/recharge-types";

const schema = z.object({
  code: z.string().min(REDEEM_CODE_MIN_LENGTH),
  session: z.string().optional(),
  email: z.string().optional(),
  mode: z.string().optional().default("session"),
  credential: z
    .object({
      mode: z.string().optional(),
      session: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-cdk-preflight", 15);
  if (limited) return limited;
  const ip = clientIp(req);
  const blocked = await redeemBlockResponse({ ip });
  if (blocked) return blocked;
  try {
    const body = schema.parse(await req.json());
    if ((body.credential?.mode || body.mode) !== "session") {
      return NextResponse.json({ error: MAILBOX_REDEEM_REMOVED }, { status: 400 });
    }
    await assertRedeemCodeKnown(body.code);
    const preflight = await preflightRedeemableCdk({
      code: body.code,
      account: {
        mode: "session",
        session: body.credential?.session || body.session || "",
        email: body.credential?.email || body.email || "",
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
    if (error instanceof RedeemRejectedError) {
      await recordRedeemFailure({ ip, outcome: error.outcome, route: "public-cdk-preflight" });
    }
    return NextResponse.json(
      { error: publicErrorMessage(error, "预检失败", "public/cdk/preflight") },
      { status: 400 },
    );
  }
}
