import { NextResponse } from "next/server";
import { z } from "zod";
import { preflightRedeemableCdk } from "@/lib/cardplatform/redeem";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { assertRedeemCodeKnown, recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";
import { publicErrorMessage } from "@/lib/public-error";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";
import { MAILBOX_REDEEM_REMOVED } from "@/lib/recharge-types";
import { assessEligibility } from "@/lib/cardplatform/preflight-core";
import { CardplatformError } from "@/lib/cardplatform/client";

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
    // 这条接口直接回浏览器：卡台报价是代理的成本线，资格结果里的 quote 和原始的 quotes / promotions 都要去掉。
    const { quote: _quote, ...eligibility } = assessEligibility(
      preflight.account,
      preflight.redeemable.planKey,
    );
    if (eligibility.verdict === "block") {
      return NextResponse.json(
        { error: eligibility.reasons.join(" "), error_code: eligibility.code, eligibility },
        { status: 400 },
      );
    }
    // 卡台响应带 { code, data } 信封，以前整个摊开会把 data 套一层，账号字段全在 data 里拿不到。
    const data = preflight.preflight.data;
    const {
      quotes: _quotes,
      promotions: _promotions,
      quote_error: _quoteError,
      ...account
    } = (data && typeof data === "object" ? data : preflight.preflight) as Record<string, unknown>;
    return NextResponse.json({
      ...account,
      eligibility,
      ok: true,
      product: preflight.redeemable.product,
      email: preflight.accountEmail,
      redemption_token: preflight.redemptionToken,
      preflight_token: preflight.preflightToken,
    });
  } catch (error) {
    if (error instanceof RedeemRejectedError) {
      await recordRedeemFailure({ ip, outcome: error.outcome, route: "public-cdk-preflight" });
    }
    const card = error instanceof CardplatformError ? error : null;
    return NextResponse.json(
      {
        error: publicErrorMessage(error, "预检失败", "public/cdk/preflight"),
        error_code: card?.errorCode || undefined,
      },
      { status: card?.httpStatus === 429 ? 429 : 400 },
    );
  }
}
