import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifySessionForRedeem } from "@/lib/session-check";
import { publicErrorMessage } from "@/lib/public-error";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";

const schema = z.object({
  session: z.string().min(1),
  code: z.string().min(REDEEM_CODE_MIN_LENGTH).optional(),
  planKey: z.string().optional(),
});

/** 预检 Session：本地格式 + 卡台 preflight + 按卡密套餐判断资格，通过后才能兑换 */
export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "session-check", 15);
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    const checked = await verifySessionForRedeem(body.session, body.code);
    const upstreamLimited =
      checked.httpStatus === 429 || checked.errorCode === "GPT_PREFLIGHT_RATE_LIMITED";

    return NextResponse.json(
      {
        ok: checked.ok,
        email: checked.email,
        name: checked.name,
        hasAccessToken: checked.hasAccessToken,
        planHint: checked.planHint,
        planKey: body.planKey,
        summary: checked.summary,
        error_code: checked.errorCode,
        retryable: checked.retryable,
        errors: checked.errors,
        warnings: checked.warnings,
        source: checked.source,
        verdict: checked.eligibility?.verdict,
        // 卡台报价是代理的成本线，这条接口直接回浏览器，一个字都不能带。
        target: checked.target,
      },
      { status: checked.ok ? 200 : upstreamLimited ? 429 : 400 },
    );
  } catch (err) {
    const message = publicErrorMessage(err, "预检失败", "recharge/session-check");
    return NextResponse.json({ ok: false, error: message, errors: [message] }, { status: 400 });
  }
}
