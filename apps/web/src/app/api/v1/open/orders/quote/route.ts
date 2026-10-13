import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openFail, openOk } from "@/lib/open-api/respond";
import { HARD_MAX_ORDER_QUANTITY } from "@/lib/store-quantity-core";
import { quoteStoreCheckout } from "@/lib/store-orders";

const quoteSchema = z.object({
  plan_key: z.string().trim().min(1).max(64),
  channel: z.enum(["alipay", "wxpay"]),
  quantity: z.number().int().min(1).max(HARD_MAX_ORDER_QUANTITY).optional(),
  coupon_code: z.string().trim().max(20).optional(),
  invoice_requested: z.boolean().optional(),
});

/** 下单前算实付金额、校验优惠券。不建单、不占券，按 Key 限流。 */
export async function POST(req: Request) {
  const auth = await requireApiKey(req, "orders:read");
  if (!isApiKeyContext(auth)) return auth;
  if (auth.ownerType !== "agent" || !auth.agentId) {
    return openFail("FORBIDDEN_SCOPE", "只有代理 Key 可以询价");
  }
  const parsed = quoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return openFail("VALIDATION_FAILED", "询价参数无效");
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, auth.agentId),
    columns: { currentSlug: true },
  });
  if (!agent?.currentSlug) return openFail("VALIDATION_FAILED", "店铺还没有地址");
  try {
    const quote = await quoteStoreCheckout({
      slug: agent.currentSlug,
      planKey: parsed.data.plan_key,
      channel: parsed.data.channel,
      quantity: parsed.data.quantity,
      couponCode: parsed.data.coupon_code,
      invoiceRequested: parsed.data.invoice_requested,
    });
    return openOk({
      list_goods_cents: quote.listGoodsCents,
      discount_cents: quote.discountCents,
      goods_cents: quote.goodsCents,
      invoice_surcharge_cents: quote.surchargeCents,
      pay_cents: quote.payCents,
      coupon_code: quote.couponCode,
      currency: "CNY",
    });
  } catch (error) {
    return openFail("VALIDATION_FAILED", error instanceof Error ? error.message : "询价失败");
  }
}
