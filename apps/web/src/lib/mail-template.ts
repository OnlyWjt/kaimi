import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { agents, mailTemplates, users } from "@/db/schema";
import { loadAgentContacts } from "@/lib/agent-contact";
import {
  AFTER_SALES_INTRO_MAX,
  AFTER_SALES_KEY,
  AFTER_SALES_TITLE_MAX,
  AFTER_SALES_SYSTEM,
  MAIL_TEMPLATE_DEFS,
  MAIL_TEMPLATE_KEYS,
  buildAfterSalesBlock,
  parseAfterSalesConfig,
  renderMailTemplate,
  validateAfterSalesConfig,
  validateMailTemplate,
  type AfterSalesConfig,
  type MailContext,
  type MailTemplate,
  type MailTemplateKey,
} from "@/lib/mail-template-core";

type Row = typeof mailTemplates.$inferSelect;

export class MailTemplateError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("；"));
  }
}

async function rowsFor(agentId: number) {
  return db.query.mailTemplates.findMany({ where: eq(mailTemplates.agentId, agentId) });
}

function byKey(rows: Row[]) {
  return new Map(rows.map((row) => [row.templateKey, row]));
}

function platformTemplate(key: MailTemplateKey, row: Row | undefined): MailTemplate | null {
  return row && row.subject != null && row.body != null ? { subject: row.subject, body: row.body } : null;
}

function platformAfterSalesText(row: Row | undefined) {
  const config = parseAfterSalesConfig(row?.configJson);
  return { title: config.title, intro: config.intro };
}

/**
 * 实际要用的模板：代理自己的（平台允许修改时）→ 平台模板 → 系统默认。
 * 平台没建过行时允许代理修改。
 */
export async function resolveMailTemplate(key: MailTemplateKey, agentId: number) {
  const [platformRows, agentRows] = await Promise.all([rowsFor(0), agentId > 0 ? rowsFor(agentId) : []]);
  const platform = byKey(platformRows).get(key);
  const mine = byKey(agentRows).get(key);
  const editable = platform?.agentEditable ?? true;
  if (editable && mine?.subject != null && mine.body != null) {
    return { template: { subject: mine.subject, body: mine.body }, layer: "agent" as const };
  }
  const fromPlatform = platformTemplate(key, platform);
  if (fromPlatform) return { template: fromPlatform, layer: "platform" as const };
  return { template: MAIL_TEMPLATE_DEFS[key].system, layer: "system" as const };
}

/** 代理的售后联系设置；没设置过时用平台默认文字、店铺联系方式全显示。 */
async function afterSalesConfigFor(agentId: number): Promise<AfterSalesConfig> {
  const [platformRow, agentRow] = await Promise.all([
    db.query.mailTemplates.findFirst({
      where: and(eq(mailTemplates.agentId, 0), eq(mailTemplates.templateKey, AFTER_SALES_KEY)),
    }),
    agentId > 0
      ? db.query.mailTemplates.findFirst({
          where: and(eq(mailTemplates.agentId, agentId), eq(mailTemplates.templateKey, AFTER_SALES_KEY)),
        })
      : undefined,
  ]);
  const platform = platformAfterSalesText(platformRow);
  return agentRow ? parseAfterSalesConfig(agentRow.configJson, platform) : { ...platform, hidden: [], extra: [] };
}

export async function loadAfterSalesBlock(agentId: number) {
  const [config, shopContacts] = await Promise.all([afterSalesConfigFor(agentId), loadAgentContacts(agentId)]);
  return buildAfterSalesBlock(config, shopContacts);
}

/** 以某家店的名义渲染一封信：取模板、补上售后联系区块。 */
export async function renderShopMail(key: MailTemplateKey, agentId: number, ctx: Omit<MailContext, "afterSales">) {
  const [{ template }, afterSales] = await Promise.all([resolveMailTemplate(key, agentId), loadAfterSalesBlock(agentId)]);
  return renderMailTemplate(key, template, { ...ctx, afterSales });
}

function assertTemplate(key: MailTemplateKey, template: MailTemplate) {
  const { errors } = validateMailTemplate(key, template);
  if (errors.length) throw new MailTemplateError(errors);
}

async function upsert(agentId: number, key: string, values: Partial<typeof mailTemplates.$inferInsert>, actorId: number) {
  const now = new Date().toISOString();
  await db
    .insert(mailTemplates)
    .values({ agentId, templateKey: key, ...values, updatedBy: actorId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [mailTemplates.agentId, mailTemplates.templateKey],
      set: { ...values, updatedBy: actorId, updatedAt: now },
    });
}

// —— 管理员 ——

export async function adminMailTemplateSnapshot() {
  const [platformRows, customized] = await Promise.all([
    rowsFor(0),
    db
      .select({
        agentId: mailTemplates.agentId,
        key: mailTemplates.templateKey,
        subject: mailTemplates.subject,
        body: mailTemplates.body,
        updatedAt: mailTemplates.updatedAt,
        displayName: agents.displayName,
        shopName: agents.shopName,
        username: users.username,
      })
      .from(mailTemplates)
      .innerJoin(agents, eq(agents.id, mailTemplates.agentId))
      .leftJoin(users, eq(users.agentId, agents.id))
      .where(gt(mailTemplates.agentId, 0))
      .orderBy(desc(mailTemplates.updatedAt)),
  ]);
  const platform = byKey(platformRows);
  return {
    templates: Object.fromEntries(
      MAIL_TEMPLATE_KEYS.map((key) => [
        key,
        {
          editable: platform.get(key)?.agentEditable ?? true,
          platform: platformTemplate(key, platform.get(key)),
          system: MAIL_TEMPLATE_DEFS[key].system,
          customized: customized
            .filter((row) => row.key === key && row.subject != null && row.body != null)
            .map((row) => ({
              agentId: row.agentId,
              name: (row.shopName || "").trim() || row.displayName,
              username: row.username || "",
              updatedAt: row.updatedAt,
              template: { subject: row.subject ?? "", body: row.body ?? "" },
            })),
        },
      ]),
    ) as Record<
      MailTemplateKey,
      {
        editable: boolean;
        platform: MailTemplate | null;
        system: MailTemplate;
        customized: Array<{ agentId: number; name: string; username: string; updatedAt: string; template: MailTemplate }>;
      }
    >,
    afterSales: { ...platformAfterSalesText(platform.get(AFTER_SALES_KEY)), system: AFTER_SALES_SYSTEM },
  };
}

export async function savePlatformTemplate(key: MailTemplateKey, template: MailTemplate, actorId: number) {
  assertTemplate(key, template);
  await upsert(0, key, { subject: template.subject, body: template.body.replace(/\r/g, "") }, actorId);
}

export async function resetPlatformTemplate(key: MailTemplateKey, actorId: number) {
  await upsert(0, key, { subject: null, body: null }, actorId);
}

export async function setAgentEditable(key: MailTemplateKey, editable: boolean, actorId: number) {
  await upsert(0, key, { agentEditable: editable }, actorId);
}

export async function savePlatformAfterSales(input: { title: string; intro: string }, actorId: number) {
  const title = input.title.trim();
  const intro = input.intro.trim();
  // 平台这里只定默认文字，联系方式由各代理自己选
  const errors: string[] = [];
  if (!title) errors.push("标题不能为空");
  if (title.length > AFTER_SALES_TITLE_MAX) errors.push(`标题最多 ${AFTER_SALES_TITLE_MAX} 字`);
  if (intro.length > AFTER_SALES_INTRO_MAX) errors.push(`说明最多 ${AFTER_SALES_INTRO_MAX} 字`);
  if (errors.length) throw new MailTemplateError(errors);
  await upsert(0, AFTER_SALES_KEY, { configJson: JSON.stringify({ title, intro }) }, actorId);
}

export async function resetAgentTemplate(agentId: number, key: MailTemplateKey | typeof AFTER_SALES_KEY) {
  const deleted = await db
    .delete(mailTemplates)
    .where(and(eq(mailTemplates.agentId, agentId), eq(mailTemplates.templateKey, key)))
    .returning({ id: mailTemplates.id });
  return deleted.length > 0;
}

// —— 代理 ——

export async function agentMailTemplateSnapshot(agentId: number) {
  const [platformRows, agentRows, shopContacts] = await Promise.all([
    rowsFor(0),
    rowsFor(agentId),
    loadAgentContacts(agentId),
  ]);
  const platform = byKey(platformRows);
  const mine = byKey(agentRows);
  const platformText = platformAfterSalesText(platform.get(AFTER_SALES_KEY));
  const myAfterSales = mine.get(AFTER_SALES_KEY);
  return {
    templates: Object.fromEntries(
      MAIL_TEMPLATE_KEYS.map((key) => {
        const row = mine.get(key);
        return [
          key,
          {
            editable: platform.get(key)?.agentEditable ?? true,
            platform: platformTemplate(key, platform.get(key)) ?? MAIL_TEMPLATE_DEFS[key].system,
            mine: row?.subject != null && row.body != null ? { subject: row.subject, body: row.body, updatedAt: row.updatedAt } : null,
          },
        ];
      }),
    ) as Record<
      MailTemplateKey,
      { editable: boolean; platform: MailTemplate; mine: (MailTemplate & { updatedAt: string }) | null }
    >,
    afterSales: {
      config: myAfterSales ? parseAfterSalesConfig(myAfterSales.configJson, platformText) : { ...platformText, hidden: [], extra: [] },
      customized: Boolean(myAfterSales),
      platform: platformText,
      shopContacts,
    },
  };
}

export async function saveAgentTemplate(agentId: number, key: MailTemplateKey, template: MailTemplate, actorId: number) {
  const platform = await db.query.mailTemplates.findFirst({
    where: and(eq(mailTemplates.agentId, 0), eq(mailTemplates.templateKey, key)),
    columns: { agentEditable: true },
  });
  if (platform && !platform.agentEditable) throw new MailTemplateError(["平台统一了这封邮件的内容，不能修改"]);
  assertTemplate(key, template);
  await upsert(agentId, key, { subject: template.subject, body: template.body.replace(/\r/g, "") }, actorId);
}

export async function saveAgentAfterSales(agentId: number, config: AfterSalesConfig, actorId: number) {
  const clean: AfterSalesConfig = {
    title: config.title.trim(),
    intro: config.intro.trim(),
    hidden: [...new Set(config.hidden)].slice(0, 50),
    extra: config.extra.map((item) => ({ type: item.type, value: item.value.trim() })),
  };
  const errors = validateAfterSalesConfig(clean, await loadAgentContacts(agentId));
  if (errors.length) throw new MailTemplateError(errors);
  await upsert(agentId, AFTER_SALES_KEY, { configJson: JSON.stringify(clean) }, actorId);
}
