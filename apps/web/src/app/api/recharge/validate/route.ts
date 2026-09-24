import { NextResponse } from "next/server";
import { z } from "zod";
import { validateCodeForRedeem } from "@/lib/inventory";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { assertRedeemCodeKnown, recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";

const schema = z.object({
  code: z.string().min(6),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "recharge-validate", 20);
  if (limited) return limited;
  const ip = clientIp(req);
  const blocked = await redeemBlockResponse({ ip });
  if (blocked) return blocked;
  try {
    const body = schema.parse(await req.json());
    await assertRedeemCodeKnown(body.code);
    const result = await validateCodeForRedeem(body.code);
    if (!result.ok) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RedeemRejectedError) {
      await recordRedeemFailure({ ip, outcome: err.outcome, route: "recharge-validate" });
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "校验失败";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
