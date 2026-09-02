import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifySessionForRedeem } from "@/lib/session-check";

const schema = z.object({
  session: z.string().min(1),
  code: z.string().min(6).optional(),
  planKey: z.string().optional(),
});

/** 预检 Session：本地格式 + 卡台 preflight，通过后才能兑换 */
export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "session-check", 15);
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    const checked = await verifySessionForRedeem(body.session, body.code);

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
        errors: checked.errors,
        warnings: checked.warnings,
        source: checked.source,
      },
      { status: checked.ok ? 200 : 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "预检失败";
    return NextResponse.json({ ok: false, error: message, errors: [message] }, { status: 400 });
  }
}
