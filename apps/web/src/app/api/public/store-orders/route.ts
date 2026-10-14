import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import { bootDb } from "@/lib/config";
import { orderLinksMailAvailable } from "@/lib/mail";
import { createStoreOrder, listStoreOrdersByEmail } from "@/lib/store-orders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { HARD_MAX_ORDER_QUANTITY } from "@/lib/store-quantity-core";
import { publicErrorMessage } from "@/lib/public-error";

const schema = z.object({
  slug: z.string().trim().min(3).max(32),
  planKey: z.string().trim().min(1).max(64),
  channel: z.enum(["alipay", "wxpay"]),
  customerEmail: z.string().trim().email("请填写有效邮箱").max(254),
  // 这里只挡明显越界的值，真正的上限是后台配置的，交给 createStoreOrder 判。
  quantity: z
    .number()
    .int("购买数量要是整数")
    .min(1, "购买数量至少 1 张")
    .max(HARD_MAX_ORDER_QUANTITY, "购买数量超出上限")
    .optional(),
  invoiceRequested: z.boolean().optional(),
  invoiceTitle: z.string().max(120).optional(),
  invoiceTaxNo: z.string().max(32).optional(),
  invoiceNote: z.string().max(200).optional(),
  invoiceEmail: z.string().max(254).optional(),
  couponCode: z.string().trim().max(20).optional(),
  regionConfirmed: z.boolean().optional(),
  referralCode: z.string().trim().max(16).optional(),
});

const lookupSchema = z.object({
  slug: z.string().trim().min(3).max(32),
  email: z.string().trim().email("请填写有效邮箱").max(254),
});

export async function GET(req: Request) {
  const limited = enforceRateLimit(req, "public-store-order-lookup", 10);
  if (limited) return limited;
  await bootDb();
  const search = new URL(req.url).searchParams;
  const parsed = lookupSchema.safeParse({
    slug: search.get("slug") || "",
    email: search.get("email") || "",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "查单参数无效" },
      { status: 400 },
    );
  }
  try {
    const list = await listStoreOrdersByEmail(parsed.data);
    const agent = await db.query.agents.findFirst({
      where: eq(agents.currentSlug, normalizeAgentSlug(parsed.data.slug)),
      columns: { mailDeliveryEnabled: true },
    });
    const canMailLinks = list.length > 0 && agent ? await orderLinksMailAvailable(agent) : false;
    return NextResponse.json({ list, canMailLinks });
  } catch (error) {
    return NextResponse.json(
      { error: publicErrorMessage(error, "查单失败", "public/store-orders") },
      { status: 400 },
    );
  }
}

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-store-order-create", 10);
  if (limited) return limited;
  await bootDb();
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "下单参数无效" },
      { status: 400 },
    );
  }
  try {
    const result = await createStoreOrder({ request: req, ...parsed.data });
    return NextResponse.json({
      orderNo: result.order.orderNo,
      queryToken: result.queryToken,
      payUrl: result.payUrl,
    });
  } catch (error) {
    return NextResponse.json(
      { error: publicErrorMessage(error, "下单失败", "public/store-orders") },
      { status: 400 },
    );
  }
}
