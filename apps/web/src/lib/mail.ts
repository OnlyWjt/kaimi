import nodemailer from "nodemailer";
import { db } from "@/db";
import { agents, issuedCdks, storeOrders } from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { getSetting, setSetting } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { formatBeijingDateTime } from "@/lib/datetime";
import { buildMailFrom, isValidMailFrom, mailDisplayName } from "@/lib/mail-core";
import { renderShopMail } from "@/lib/mail-template";
import type { MailContext, MailTemplateKey, RenderedMail } from "@/lib/mail-template-core";
import { getPublicBaseUrl } from "@/lib/public-url";
import { storeOrderQueryUrl } from "@/lib/store-order-links";
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

export type MailSettings = {
  enabled: boolean;
  orderEnabled: boolean;
  starttls: boolean;
  ssl: boolean;
  host: string;
  port: string;
  user: string;
  passwordConfigured: boolean;
  from: string;
  fromName: string;
};

export async function readMailSettings(): Promise<MailSettings> {
  const [enabled, orderEnabled, starttls, ssl, host, port, user, pass, from, fromName] = await Promise.all([
    getSetting("mail_enabled", "0"),
    getSetting("mail_order_enabled", "0"),
    getSetting("mail_starttls", "0"),
    getSetting("mail_ssl", "1"),
    getSetting("mail_host", ""),
    getSetting("mail_port", "465"),
    getSetting("mail_user", ""),
    getSetting("mail_pass", ""),
    getSetting("mail_from", ""),
    getSetting("mail_from_name", ""),
  ]);
  return {
    enabled: enabled === "1",
    orderEnabled: orderEnabled === "1",
    starttls: starttls === "1",
    ssl: ssl !== "0",
    host,
    port: port || "465",
    user,
    passwordConfigured: Boolean(pass),
    from,
    fromName,
  };
}

export async function saveMailSettings(input: {
  enabled: boolean;
  orderEnabled: boolean;
  starttls: boolean;
  ssl: boolean;
  host: string;
  port: string;
  user: string;
  password?: string;
  from: string;
  fromName: string;
}) {
  if (!isValidMailFrom(input.from)) throw new Error("发件邮箱格式不正确");
  await setSetting("mail_enabled", input.enabled ? "1" : "0");
  await setSetting("mail_order_enabled", input.orderEnabled ? "1" : "0");
  await setSetting("mail_starttls", input.starttls ? "1" : "0");
  await setSetting("mail_ssl", input.ssl ? "1" : "0");
  await setSetting("mail_host", input.host.trim());
  await setSetting("mail_port", String(Number(input.port) || 465));
  await setSetting("mail_user", input.user.trim());
  await setSetting("mail_from", input.from.trim());
  await setSetting("mail_from_name", mailDisplayName(input.fromName));
  if (input.password?.trim()) {
    await setSetting("mail_pass", encryptSecret(input.password.trim()));
  }
}

async function transporter() {
  const settings = await readMailSettings();
  if (!settings.host) throw new Error("先填写 SMTP 主机");
  const pass = await getSetting("mail_pass", "");
  const port = Number(settings.port) || 465;
  return {
    settings,
    mailer: nodemailer.createTransport({
      host: settings.host,
      port,
      secure: settings.ssl,
      requireTLS: settings.starttls,
      auth: settings.user ? { user: settings.user, pass: pass ? decryptSecret(pass) : "" } : undefined,
    }),
  };
}

export async function sendTestMail(to: string) {
  const { settings, mailer } = await transporter();
  if (!settings.enabled) throw new Error("先启用邮件发送");
  const from = buildMailFrom(settings.fromName, settings.from || settings.user);
  await mailer.sendMail({
    from,
    to,
    subject: "Kaimi 邮件测试",
    text: "这是一封测试邮件。收到它说明 SMTP 配置可用。",
  });
}

/** 模板编辑页的「发测试邮件」。agentId 给了就用那家店的发件人名称和回复邮箱。只要求平台开了邮件发送。 */
export async function sendTemplateTestMail(input: { agentId: number | null; to: string; mail: RenderedMail }) {
  const { settings, mailer } = await transporter();
  if (!settings.enabled) throw new Error("平台还没启用邮件发送");
  const agent = input.agentId ? await db.query.agents.findFirst({ where: eq(agents.id, input.agentId) }) : null;
  const shop = agent ? publicShopName(agent) : "";
  const displayName = mailDisplayName(agent?.mailFromName || "") || mailDisplayName(settings.fromName) || shop;
  await mailer.sendMail({
    from: buildMailFrom(displayName, settings.from || settings.user),
    replyTo: agent && validReplyTo(agent.mailReplyTo) ? agent.mailReplyTo.trim() : undefined,
    to: input.to.trim(),
    subject: `[测试] ${input.mail.subject}`,
    text: input.mail.text,
    html: input.mail.html,
  });
}

const MAIL_ATTEMPTS = 5;
const MAIL_RETRY_MS = 3 * 24 * 60 * 60 * 1000;
const MAIL_SENDING_STALE_MS = 2 * 60 * 1000;

function validReplyTo(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function writeDeliveryMail(
  orderId: number,
  status: string,
  error: string,
  countAttempt = false,
) {
  await db
    .update(storeOrders)
    .set({
      deliveryMailStatus: status,
      deliveryMailError: error.slice(0, 300),
      // 在 SQL 里自增，避免基于旧快照的读改写丢失计数
      ...(countAttempt ? { deliveryMailAttempts: sql`${storeOrders.deliveryMailAttempts} + 1` } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(storeOrders.id, orderId));
}

export async function sendDeliveryMail(orderId: number) {
  const existing = await db.query.storeOrders.findFirst({ where: eq(storeOrders.id, orderId) });
  if (!existing || existing.fulfillStatus !== "delivered") return;
  if (existing.deliveryMailStatus === "sent" || existing.deliveryMailStatus === "skipped") return;
  if (existing.deliveryMailAttempts >= MAIL_ATTEMPTS) return;

  const now = new Date().toISOString();
  const stale = new Date(Date.now() - MAIL_SENDING_STALE_MS).toISOString();
  const [claimed] = await db
    .update(storeOrders)
    .set({ deliveryMailStatus: "sending", updatedAt: now })
    .where(
      and(
        eq(storeOrders.id, orderId),
        eq(storeOrders.fulfillStatus, "delivered"),
        or(
          inArray(storeOrders.deliveryMailStatus, ["pending", "failed"]),
          and(eq(storeOrders.deliveryMailStatus, "sending"), lt(storeOrders.updatedAt, stale)),
        ),
      ),
    )
    .returning({ id: storeOrders.id });
  if (!claimed) return;

  try {
    const settings = await readMailSettings();
    if (!settings.enabled || !settings.orderEnabled || !settings.host) {
      // skipped 不会被 retryPendingDeliveryMails 取出，避免调度器空转
      await writeDeliveryMail(orderId, "skipped", "平台订单邮件未开启");
      return;
    }
    const order = await db.query.storeOrders.findFirst({ where: eq(storeOrders.id, orderId) });
    if (!order) return;
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, order.agentId) });
    if (agent && !agent.mailDeliveryEnabled) {
      await writeDeliveryMail(orderId, "skipped", "代理关闭了发货邮件");
      return;
    }
    if (!order.customerEmail) {
      await writeDeliveryMail(orderId, "skipped", "没有买家邮箱");
      return;
    }
    const cards = await db.select().from(issuedCdks).where(eq(issuedCdks.orderId, order.id));
    const lines = cards
      .map((row) => {
        try {
          return decryptSecret(row.codeEncrypted);
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    if (!lines.length) {
      await writeDeliveryMail(orderId, "failed", "没有可发送的交付内容", true);
      return;
    }
    const { mailer } = await transporter();
    const shop = agent ? publicShopName(agent) : "";
    const displayName = mailDisplayName(agent?.mailFromName || "") || mailDisplayName(settings.fromName) || shop;
    const from = buildMailFrom(displayName, settings.from || settings.user);
    const replyTo = agent && validReplyTo(agent.mailReplyTo) ? agent.mailReplyTo.trim() : undefined;
    // 邀请好友卡片：店铺开了邀请有礼、这个买家有邀请码时才有。出错不影响发货邮件。
    const invite = await import("@/lib/referrals")
      .then(({ referralInviteMailBlock }) => referralInviteMailBlock(order))
      .catch(() => null);
    const origin = await getPublicBaseUrl();
    let queryUrl = "";
    if (origin && order.queryTokenEncrypted) {
      try {
        queryUrl = storeOrderQueryUrl(origin, order.orderNo, decryptSecret(order.queryTokenEncrypted));
      } catch {
        queryUrl = "";
      }
    }
    // 标题、正文按代理 / 平台的模板来；售后联系区块由模板模块补上
    const mail = await renderShopMail("delivery", order.agentId, {
      vars: {
        shop: shop || "订单",
        order_no: order.orderNo,
        product: order.productNameSnapshot,
        quantity: String(order.quantity || 1),
        paid_at: formatBeijingDateTime(order.paidAt),
        buyer_email: order.customerEmail,
        query_url: queryUrl,
      },
      items: lines,
      invite,
    });
    await mailer.sendMail({
      from,
      replyTo,
      to: order.customerEmail,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    await writeDeliveryMail(orderId, "sent", "");
  } catch (error) {
    const message = error instanceof Error ? error.message : "发信失败";
    console.warn(`[kaimi-mail] 发货邮件失败：${message}`);
    await writeDeliveryMail(orderId, "failed", message, true);
  }
}

export type ShopMailResult = { sent: true } | { sent: false; reason: string };

/**
 * 以某家店的名义给买家发一封信（邀请券到账、到期提醒等）。
 * 和发货邮件同一套开关：平台订单邮件没开、代理关了发货邮件就不发，返回原因。
 */
export async function sendShopMail(input: {
  agentId: number;
  to: string;
  template: MailTemplateKey;
  context: (shop: string) => Omit<MailContext, "afterSales">;
}): Promise<ShopMailResult> {
  const settings = await readMailSettings();
  if (!settings.enabled || !settings.orderEnabled || !settings.host) {
    return { sent: false, reason: "平台订单邮件未开启" };
  }
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, input.agentId) });
  if (!agent) return { sent: false, reason: "店铺不存在" };
  if (!agent.mailDeliveryEnabled) return { sent: false, reason: "代理关闭了发货邮件" };
  if (!input.to.trim()) return { sent: false, reason: "没有买家邮箱" };
  const { mailer } = await transporter();
  const shop = publicShopName(agent);
  const displayName = mailDisplayName(agent.mailFromName || "") || mailDisplayName(settings.fromName) || shop;
  await mailer.sendMail({
    from: buildMailFrom(displayName, settings.from || settings.user),
    replyTo: validReplyTo(agent.mailReplyTo) ? agent.mailReplyTo.trim() : undefined,
    to: input.to.trim(),
    ...(await renderShopMail(input.template, agent.id, input.context(shop))),
  });
  return { sent: true };
}

export async function retryPendingDeliveryMails(limit = 10) {
  const cutoff = new Date(Date.now() - MAIL_RETRY_MS).toISOString();
  const rows = await db
    .select({ id: storeOrders.id })
    .from(storeOrders)
    .where(
      and(
        eq(storeOrders.fulfillStatus, "delivered"),
        inArray(storeOrders.deliveryMailStatus, ["pending", "failed"]),
        lt(storeOrders.deliveryMailAttempts, MAIL_ATTEMPTS),
        gte(storeOrders.deliveredAt, cutoff),
      ),
    )
    .limit(limit);
  for (const row of rows) {
    await sendDeliveryMail(row.id);
  }
  return { checked: rows.length };
}

/** 平台开了订单邮件、代理也没关发货邮件时，才能给买家发查单链接。 */
export async function orderLinksMailAvailable(agent: { mailDeliveryEnabled: boolean }) {
  const settings = await readMailSettings();
  return settings.enabled && settings.orderEnabled && Boolean(settings.host) && agent.mailDeliveryEnabled;
}

/**
 * 把这个邮箱在本店最近的订单查单链接发到这个邮箱。
 * 只有邮箱的主人能收到，所以链接里可以带查询凭证。返回发出的订单数；没订单不发信。
 */
export async function sendOrderLinksMail(input: {
  agentId: number;
  email: string;
  baseUrl: string;
}) {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, input.agentId) });
  if (!agent || !(await orderLinksMailAvailable(agent))) {
    throw new Error("本店暂时不能发送查单邮件，请用完整订单号查看");
  }
  const email = input.email.trim().toLowerCase();
  const orders = await db.query.storeOrders.findMany({
    where: and(eq(storeOrders.agentId, agent.id), eq(storeOrders.customerEmail, email)),
    orderBy: (table, { desc }) => [desc(table.id)],
    limit: 20,
  });
  const links = orders.flatMap((order) => {
    if (!order.queryTokenEncrypted) return [];
    let token = "";
    try {
      token = decryptSecret(order.queryTokenEncrypted);
    } catch {
      return [];
    }
    const url = storeOrderQueryUrl(input.baseUrl, order.orderNo, token);
    return [{ product: order.productNameSnapshot, orderNo: order.orderNo, url }];
  });
  if (!links.length) return 0;
  const { settings, mailer } = await transporter();
  const shop = publicShopName(agent);
  const displayName = mailDisplayName(agent.mailFromName || "") || mailDisplayName(settings.fromName) || shop;
  await mailer.sendMail({
    from: buildMailFrom(displayName, settings.from || settings.user),
    replyTo: validReplyTo(agent.mailReplyTo) ? agent.mailReplyTo.trim() : undefined,
    to: email,
    ...(await renderShopMail("order_links", agent.id, {
      vars: { shop: shop || "订单", buyer_email: email },
      orders: links,
    })),
  });
  return links.length;
}

/**
 * 代理在后台点「重发发货邮件」。已发过的也重新发一次；仍受平台和代理的邮件开关约束。
 */
export async function resendDeliveryMail(orderId: number) {
  const [reset] = await db
    .update(storeOrders)
    .set({ deliveryMailStatus: "pending", deliveryMailAttempts: 0, updatedAt: new Date().toISOString() })
    .where(and(eq(storeOrders.id, orderId), eq(storeOrders.fulfillStatus, "delivered")))
    .returning({ id: storeOrders.id });
  if (!reset) throw new Error("订单还没发齐，不能重发发货邮件");
  await sendDeliveryMail(orderId);
  const after = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, orderId),
    columns: { deliveryMailStatus: true, deliveryMailError: true },
  });
  return after;
}
