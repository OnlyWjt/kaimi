import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { sendTemplateTestMail } from "@/lib/mail";
import {
  MailTemplateError,
  agentMailTemplateSnapshot,
  loadAfterSalesBlock,
  resetAgentTemplate,
  saveAgentAfterSales,
  saveAgentTemplate,
} from "@/lib/mail-template";
import { AFTER_SALES_KEY, MAIL_TEMPLATE_KEYS, renderMailTemplate, sampleMailContext } from "@/lib/mail-template-core";
import { getPublicBaseUrl } from "@/lib/public-url";
import { enforceRateLimitFor } from "@/lib/rate-limit";

const key = z.enum(MAIL_TEMPLATE_KEYS);
const template = z.object({ subject: z.string().max(500), body: z.string().max(20000) });
const contactType = z.enum(["telegram", "wechat", "qq", "email", "link"]);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), key, template }),
  z.object({ action: z.literal("reset"), key: z.union([key, z.literal(AFTER_SALES_KEY)]) }),
  z.object({
    action: z.literal("save_after_sales"),
    config: z.object({
      title: z.string().max(200),
      intro: z.string().max(1000),
      hidden: z.array(z.string().max(300)).max(50),
      extra: z.array(z.object({ type: contactType, value: z.string().max(300) })).max(20),
    }),
  }),
  z.object({ action: z.literal("test"), key, template, to: z.string().trim().email().max(254) }),
]);

export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json(await agentMailTemplateSnapshot(session.agentId));
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = actionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "请求内容不完整" }, { status: 400 });
  const input = parsed.data;
  const agentId = session.agentId;
  try {
    if (input.action === "test") {
      // 防止拿测试邮件群发：每个代理每天 10 封
      const limited = enforceRateLimitFor(`mail-template-test:agent:${agentId}`, 10, 24 * 60 * 60_000);
      if (limited) return limited;
      const [agent, afterSales, origin] = await Promise.all([
        db.query.agents.findFirst({ where: eq(agents.id, agentId) }),
        loadAfterSalesBlock(agentId),
        getPublicBaseUrl(req),
      ]);
      const mail = renderMailTemplate(
        input.key,
        input.template,
        sampleMailContext({ shop: agent ? publicShopName(agent) : "我的店铺", afterSales, origin }),
      );
      await sendTemplateTestMail({ agentId, to: input.to, mail });
      return NextResponse.json({ ok: true });
    }
    if (input.action === "save") await saveAgentTemplate(agentId, input.key, input.template, session.id);
    if (input.action === "reset") await resetAgentTemplate(agentId, input.key);
    if (input.action === "save_after_sales") await saveAgentAfterSales(agentId, input.config, session.id);
  } catch (error) {
    if (error instanceof MailTemplateError) {
      return NextResponse.json({ error: error.errors[0], errors: error.errors }, { status: 400 });
    }
    if (input.action === "test") {
      return NextResponse.json({ error: error instanceof Error ? error.message : "发送失败" }, { status: 400 });
    }
    throw error;
  }
  await writeAuditLog({
    actor: session,
    action: `agent.mail_template.${input.action}`,
    targetType: "mail_template",
    targetId: `${agentId}:${input.action === "save_after_sales" ? AFTER_SALES_KEY : input.key}`,
  });
  return NextResponse.json(await agentMailTemplateSnapshot(agentId));
}
