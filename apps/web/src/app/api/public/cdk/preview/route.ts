import { NextResponse } from "next/server";
import { z } from "zod";
import { previewRedeemableCdk, summarizePreview } from "@/lib/cardplatform/redeem";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  code: z.string().min(6),
});

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-cdk-preview", 20);
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    const previewed = await previewRedeemableCdk(body.code);
    return NextResponse.json({
      ...previewed.payload,
      ...summarizePreview(previewed),
      redemption_token: previewed.redemptionToken,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "预览失败" },
      { status: 400 },
    );
  }
}
