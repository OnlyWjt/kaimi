import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentStorefronts, agents, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/config";
import { formatDateTime } from "@/lib/datetime";
import { dispatchNotifyText } from "@/lib/notify";
import {
  CONTACT_ENFORCE_SETTING,
  contactGate,
  hasSupportContact,
  type ContactGate,
} from "@/lib/agent-contact-core";
import { parseContactsJson, type ContactItem } from "@/lib/agent-storefront-config";

export async function loadAgentContacts(agentId: number): Promise<ContactItem[]> {
  const row = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agentId),
    columns: { contactsJson: true },
  });
  return parseContactsJson(row?.contactsJson);
}

export async function agentContactGate(agentId: number): Promise<ContactGate> {
  const [contacts, enforceAt] = await Promise.all([
    loadAgentContacts(agentId),
    getSetting(CONTACT_ENFORCE_SETTING, ""),
  ]);
  return contactGate(hasSupportContact(contacts), enforceAt);
}

/** 下单入口统一调用。买家只看到店铺暂停接单，具体原因写进服务端日志。 */
export async function assertAgentContactReady(agentId: number) {
  const gate = await agentContactGate(agentId);
  if (gate.state === "blocked") {
    console.warn(`[store-order] 拒绝下单：代理 ${agentId} 未填写售后联系方式`);
    throw new Error("店铺暂停接单，请稍后再来。");
  }
}

const REMINDER_KEY_PREFIX = "agent_contact_reminded:";

/**
 * 没填售后联系方式的代理发 Telegram 提醒：进宽限期一次、停止接单时一次。
 * 已发过的状态记在 settings 里，填好之后清掉，下次再缺会重新提醒。
 */
export async function remindAgentsMissingContact() {
  const enforceAt = await getSetting(CONTACT_ENFORCE_SETTING, "");
  const rows = await db
    .select({
      id: agents.id,
      telegramChatId: agents.telegramChatId,
      telegramNotifyEnabled: agents.telegramNotifyEnabled,
      contactsJson: agentStorefronts.contactsJson,
    })
    .from(agents)
    .leftJoin(agentStorefronts, eq(agentStorefronts.agentId, agents.id))
    .where(eq(agents.status, "active"));
  const keys = rows.map((row) => `${REMINDER_KEY_PREFIX}${row.id}`);
  const sentState = new Map(
    keys.length
      ? (await db.select().from(settings).where(inArray(settings.key, keys))).map((row) => [row.key, row.value])
      : [],
  );
  let sent = 0;
  for (const row of rows) {
    const key = `${REMINDER_KEY_PREFIX}${row.id}`;
    const gate = contactGate(hasSupportContact(parseContactsJson(row.contactsJson)), enforceAt);
    if (gate.state === "ok") {
      if (sentState.has(key)) await db.delete(settings).where(eq(settings.key, key));
      continue;
    }
    if (sentState.get(key) === gate.state) continue;
    // 先记状态再发：没绑 Telegram 或发送失败都不反复重试，后台横幅一直挂着。
    await setSetting(key, gate.state);
    if (!row.telegramChatId || row.telegramNotifyEnabled === false) continue;
    const text =
      gate.state === "blocked"
        ? "【店铺已暂停接单】你还没有填写售后联系方式（微信、QQ 或 Telegram）。买家付款后找不到人会去投诉支付通道，所以没有联系方式的店铺不能接单。请到代理后台「店铺装修 → 售后联系方式」填写，填好后立即恢复。"
        : `【请填写售后联系方式】平台要求每家店铺至少留一个微信、QQ 或 Telegram，会显示在买家订单页和发货邮件里。请在 ${formatDateTime(gate.deadline)} 前到代理后台「店铺装修 → 售后联系方式」填写，逾期店铺会暂停接单。`;
    try {
      const result = await dispatchNotifyText(
        text,
        { audience: "agent", agentId: row.id },
        "agent.contact.required",
        { telegramChatId: row.telegramChatId, webhookUrl: "" },
      );
      if (result.telegram.ok) sent += 1;
    } catch (error) {
      console.warn(`[agent-contact] 提醒代理 ${row.id} 失败`, error instanceof Error ? error.message : error);
    }
  }
  return { checked: rows.length, sent };
}
