import { NextResponse } from "next/server";
import { z } from "zod";
import { previewRedeemableCdk, summarizePreview } from "@/lib/cardplatform/redeem";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { assertRedeemCodeKnown, recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";

const schema = z.object({
  code: z.string().min(6),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-cdk-preview", 20);
  if (limited) return limited;
  const ip = clientIp(req);
  const blocked = await redeemBlockResponse({ ip });
  if (blocked) return blocked;
  try {
    const body = schema.parse(await req.json());
    await assertRedeemCodeKnown(body.code);
    const previewed = await previewRedeemableCdk(body.code);
    return NextResponse.json({
      ...previewed.payload,
      ...summarizePreview(previewed),
      redemption_token: previewed.redemptionToken,
    });
  } catch (error) {
    if (error instanceof RedeemRejectedError) {
      await recordRedeemFailure({
        ip,
        outcome: error.outcome,
        route: "public-cdk-preview",
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "预览失败" },
      { status: 400 },
    );
  }
}
