import nodemailer from "nodemailer";
import { db } from "@/db";
import { agents, issuedCdks, storeOrders } from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { getSetting, setSetting } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { buildMailFrom, isValidMailFrom, mailDisplayName } from "@/lib/mail-core";
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
    const body = [shop, `订单号 ${order.orderNo}`, "", ...lines]
      .filter((line, index) => line || index > 0)
      .join("\n");
    await mailer.sendMail({
      from,
      replyTo,
      to: order.customerEmail,
      subject: `${shop || "订单"} ${order.orderNo}`,
      text: body,
    });
    await writeDeliveryMail(orderId, "sent", "");
  } catch (error) {
    const message = error instanceof Error ? error.message : "发信失败";
    console.warn(`[kaimi-mail] 发货邮件失败：${message}`);
    await writeDeliveryMail(orderId, "failed", message, true);
  }
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
  const lines = orders.flatMap((order) => {
    if (!order.queryTokenEncrypted) return [];
    let token = "";
    try {
      token = decryptSecret(order.queryTokenEncrypted);
    } catch {
      return [];
    }
    const url = storeOrderQueryUrl(input.baseUrl, order.orderNo, token);
    return [`${order.productNameSnapshot}  订单号 ${order.orderNo}`, url, ""];
  });
  if (!lines.length) return 0;
  const { settings, mailer } = await transporter();
  const shop = publicShopName(agent);
  const displayName = mailDisplayName(agent.mailFromName || "") || mailDisplayName(settings.fromName) || shop;
  await mailer.sendMail({
    from: buildMailFrom(displayName, settings.from || settings.user),
    replyTo: validReplyTo(agent.mailReplyTo) ? agent.mailReplyTo.trim() : undefined,
    to: email,
    subject: `${shop || "订单"} 查单链接`,
    text: [shop, "下面是你在本店的订单，点链接查看卡密和发货状态。不是你本人操作的请忽略这封邮件。", "", ...lines].join("\n"),
  });
  return lines.length / 3;
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
