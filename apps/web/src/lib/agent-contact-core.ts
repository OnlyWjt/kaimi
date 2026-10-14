import type { ContactItem, ContactType } from "./agent-storefront-config";

/**
 * 代理售后联系方式：没有就不能接单。
 * 买家付款后找不到店主，会直接去支付渠道投诉，通道会被封。
 * 邮箱和网页链接可以填，但回复太慢，不单独算数；至少要有一个微信 / QQ / Telegram。
 */

export const SUPPORT_CONTACT_TYPES = ["wechat", "qq", "telegram"] as const satisfies readonly ContactType[];

/** 上线时写入「现在 + 宽限天数」，之后没填的店停止接单。 */
export const CONTACT_ENFORCE_SETTING = "agent_contact_enforce_at";
export const CONTACT_GRACE_DAYS = 3;

const WECHAT_ID_RE = /^[a-zA-Z][-_a-zA-Z0-9]{5,19}$/;
const CN_MOBILE_RE = /^1\d{10}$/;
const QQ_RE = /^[1-9]\d{4,11}$/;
const TG_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const TG_LINK_RE = /^(?:https?:\/\/)?t\.me\/(\S+)$/i;

/** 微信 / QQ / Telegram 的格式校验；其他类型不在这里管，返回 null。 */
export function contactValueError(type: ContactType, raw: string): string | null {
  const value = raw.trim();
  if (type === "wechat") {
    return WECHAT_ID_RE.test(value) || CN_MOBILE_RE.test(value)
      ? null
      : "微信号格式不对：6–20 位，字母开头，可含字母、数字、_ 和 -；或填 11 位手机号";
  }
  if (type === "qq") {
    return QQ_RE.test(value) ? null : "QQ 号格式不对：5–12 位数字";
  }
  if (type === "telegram") {
    const link = TG_LINK_RE.exec(value);
    if (link) return link[1].replace(/\/+$/, "") ? null : "Telegram 链接不完整";
    return TG_USERNAME_RE.test(value.replace(/^@/, ""))
      ? null
      : "Telegram 格式不对：填 @用户名 或 t.me/ 链接";
  }
  return null;
}

function isSupportType(type: ContactType) {
  return (SUPPORT_CONTACT_TYPES as readonly ContactType[]).includes(type);
}

export function isValidSupportContact(contact: Pick<ContactItem, "type" | "value">) {
  return isSupportType(contact.type) && contactValueError(contact.type, contact.value) === null;
}

export function hasSupportContact(contacts: Pick<ContactItem, "type" | "value">[]) {
  return contacts.some(isValidSupportContact);
}

export function contactHref(contact: Pick<ContactItem, "type" | "value">): string | null {
  const value = contact.value.trim();
  if (contact.type === "email") return `mailto:${value}`;
  if (contact.type === "link") return value;
  if (contact.type === "telegram") {
    const link = TG_LINK_RE.exec(value);
    return `https://t.me/${link ? link[1] : value.replace(/^@/, "")}`;
  }
  return null;
}

export function contactTypeLabel(type: ContactType) {
  if (type === "telegram") return "Telegram";
  if (type === "email") return "售后邮箱";
  if (type === "wechat") return "微信";
  if (type === "qq") return "QQ";
  return "联系我们";
}

/** 给买家看的售后联系方式：格式不对的不展示，微信 / QQ / TG 排在前面。 */
export function afterSalesContacts<T extends Pick<ContactItem, "type" | "value">>(contacts: T[]): T[] {
  const usable = contacts.filter((contact) => {
    if (!contact.value.trim()) return false;
    return isSupportType(contact.type) ? isValidSupportContact(contact) : true;
  });
  return [
    ...usable.filter((contact) => isSupportType(contact.type)),
    ...usable.filter((contact) => !isSupportType(contact.type)),
  ];
}

/** 发货邮件里的售后段落，纯文本。没有可用联系方式时返回空数组。 */
export function afterSalesMailLines(contacts: Pick<ContactItem, "type" | "value" | "label">[]) {
  const list = afterSalesContacts(contacts);
  if (!list.length) return [];
  return [
    "",
    "售后联系",
    "卡密或账号有任何问题，请直接联系店主处理：",
    ...list.map((contact) => `${contact.label.zh.trim() || contactTypeLabel(contact.type)}：${contact.value.trim()}`),
  ];
}

export type ContactGate =
  | { state: "ok" }
  | { state: "grace"; deadline: string }
  | { state: "blocked"; deadline: string };

/**
 * 有有效联系方式就放行；没有时在宽限期内只提醒，过了宽限期停止接单。
 * 宽限期配置读不出来按已过期处理：宁可关店，也不能让找不到人的单继续付款。
 */
export function contactGate(hasContact: boolean, enforceAt: string, now = Date.now()): ContactGate {
  if (hasContact) return { state: "ok" };
  const deadline = Date.parse(enforceAt);
  if (Number.isFinite(deadline) && now < deadline) return { state: "grace", deadline: enforceAt };
  return { state: "blocked", deadline: enforceAt };
}

export function graceDeadlineFrom(now = Date.now()) {
  return new Date(now + CONTACT_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
