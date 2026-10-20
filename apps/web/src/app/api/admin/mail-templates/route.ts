import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { sendTemplateTestMail } from "@/lib/mail";
import {
  MailTemplateError,
  adminMailTemplateSnapshot,
  resetAgentTemplate,
  resetPlatformTemplate,
  savePlatformAfterSales,
  savePlatformTemplate,
  setAgentEditable,
} from "@/lib/mail-template";
import {
  AFTER_SALES_KEY,
  AFTER_SALES_SYSTEM,
  MAIL_TEMPLATE_KEYS,
  renderMailTemplate,
  sampleMailContext,
} from "@/lib/mail-template-core";
import { getPublicBaseUrl } from "@/lib/public-url";
import { enforceRateLimitFor } from "@/lib/rate-limit";

const key = z.enum(MAIL_TEMPLATE_KEYS);
const template = z.object({ subject: z.string().max(500), body: z.string().max(20000) });

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), key, template }),
  z.object({ action: z.literal("reset"), key }),
  z.object({ action: z.literal("editable"), key, editable: z.boolean() }),
  z.object({ action: z.literal("save_after_sales"), title: z.string().max(200), intro: z.string().max(1000) }),
  z.object({
    action: z.literal("reset_agent"),
    agentId: z.number().int().positive(),
    key: z.union([key, z.literal(AFTER_SALES_KEY)]),
  }),
  z.object({ action: z.literal("test"), key, template, to: z.string().trim().email().max(254) }),
]);

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json(await adminMailTemplateSnapshot());
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = actionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "请求内容不完整" }, { status: 400 });
  const input = parsed.data;
  try {
    if (input.action === "test") {
      const limited = enforceRateLimitFor(`mail-template-test:admin:${session.id}`, 20, 60 * 60_000);
      if (limited) return limited;
      const mail = renderMailTemplate(
        input.key,
        input.template,
        sampleMailContext({
          shop: "示例店铺",
          origin: await getPublicBaseUrl(req),
          afterSales: { ...AFTER_SALES_SYSTEM, contacts: [{ label: "微信", value: "example_shop", href: "" }] },
        }),
      );
      await sendTemplateTestMail({ agentId: null, to: input.to, mail });
      return NextResponse.json({ ok: true });
    }
    if (input.action === "save") await savePlatformTemplate(input.key, input.template, session.id);
    if (input.action === "reset") await resetPlatformTemplate(input.key, session.id);
    if (input.action === "editable") await setAgentEditable(input.key, input.editable, session.id);
    if (input.action === "save_after_sales") await savePlatformAfterSales(input, session.id);
    if (input.action === "reset_agent" && !(await resetAgentTemplate(input.agentId, input.key))) {
      return NextResponse.json({ error: "这个代理没有自定义这封邮件" }, { status: 404 });
    }
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
    action: `mail_template.${input.action}`,
    targetType: "mail_template",
    targetId: input.action === "save_after_sales" ? AFTER_SALES_KEY : input.key,
    metadata: {
      ...(input.action === "editable" ? { editable: input.editable } : {}),
      ...(input.action === "reset_agent" ? { agentId: input.agentId } : {}),
    },
  });
  return NextResponse.json(await adminMailTemplateSnapshot());
}
