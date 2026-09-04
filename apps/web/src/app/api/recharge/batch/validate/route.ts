import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceBatchRateLimit } from "@/lib/batch-rate-limit";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";
import { previewRedeemCodes } from "@/lib/recharge-batch";
import { clampRedeemCodes } from "@/lib/recharge-batch-core";

const schema = z.object({
  codes: z.array(z.string()).min(1).max(200),
});

export async function POST(req: Request) {
  const limited = await enforceBatchRateLimit(req, "recharge-batch-validate", {
    anonymous: 6,
    agent: 30,
  });
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    const limit = await getBatchRedeemLimit();
    const { codes, dropped } = clampRedeemCodes(body.codes, limit);
    if (!codes.length) {
      return NextResponse.json({ error: "请填写要兑换的卡密" }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      limit,
      dropped,
      list: await previewRedeemCodes(codes),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "校验失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
