import { NextResponse } from "next/server";
import { z } from "zod";
import { validateCodeForRedeem } from "@/lib/inventory";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  code: z.string().min(6),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "recharge-validate", 20);
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    const result = await validateCodeForRedeem(body.code);
    if (!result.ok) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "校验失败";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
