import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import { bootDb } from "@/lib/config";
import { sendOrderLinksMail } from "@/lib/mail";
import { requirePublicBaseUrl } from "@/lib/public-url";
import { enforceRateLimit, enforceRateLimitFor } from "@/lib/rate-limit";

const schema = z.object({
  slug: z.string().trim().min(3).max(32),
  email: z.string().trim().email("请填写有效邮箱").max(254),
});

/** 把查单链接发到买家邮箱。只有邮箱主人能收到，所以不需要再验订单号。 */
export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "public-store-order-send-links", 5);
  if (limited) return limited;
  await bootDb();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }
  // 同一个邮箱一小时最多 3 封，免得被人拿来轰炸别人的邮箱。
  const email = parsed.data.email.toLowerCase();
  const perEmail = enforceRateLimitFor(`store-order-links-mail:${email}`, 3, 60 * 60_000);
  if (perEmail) return perEmail;
  const agent = await db.query.agents.findFirst({
    where: eq(agents.currentSlug, normalizeAgentSlug(parsed.data.slug)),
    columns: { id: true, status: true },
  });
  if (!agent || agent.status !== "active") {
    return NextResponse.json({ error: "店铺不存在或已关闭" }, { status: 404 });
  }
  try {
    await sendOrderLinksMail({
      agentId: agent.id,
      email,
      baseUrl: await requirePublicBaseUrl(req),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "发送失败，请稍后再试" },
      { status: 400 },
    );
  }
  // 有没有订单都回同一句，别让这个接口变成「这个邮箱在不在本店买过」的探针。
  return NextResponse.json({ ok: true, message: "如果这个邮箱在本店有订单，查单链接已经发过去了，请查收邮件。" });
}
