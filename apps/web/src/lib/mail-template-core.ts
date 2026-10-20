/**
 * 买家邮件模板：定义、校验、渲染。纯函数，后台预览（浏览器）和发信（服务端）共用同一份，
 * 预览看到的就是买家收到的。设计见 docs/mail-template-design.md。
 *
 * 模板是「标题 + 正文」两段文字。正文支持：空行分段、**加粗**、[文字](https://...)、
 * 直接写网址、单独一行 --- 分隔线、{{变量}}。区块变量（卡密、售后联系……）要单独占一行，
 * 渲染成一整块，内容为空时整行去掉。一次输出 HTML 版和纯文本版，两边内容一致。
 */
import {
  afterSalesContacts,
  contactHref,
  contactTypeLabel,
  contactValueError,
  hasSupportContact,
} from "./agent-contact-core";
import type { ContactItem, ContactType } from "./agent-storefront-config";

export const MAIL_TEMPLATE_KEYS = ["delivery", "order_links", "coupon_notice", "coupon_remind"] as const;
export type MailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];
/** 售后联系是所有邮件共用的区块，和四封信存在同一张表里。 */
export const AFTER_SALES_KEY = "after_sales";

export const MAIL_SUBJECT_MAX = 120;
export const MAIL_BODY_MAX = 5000;
export const AFTER_SALES_TITLE_MAX = 20;
export const AFTER_SALES_INTRO_MAX = 120;

export type MailTemplate = { subject: string; body: string };

type TemplateDef = {
  label: string;
  hint: string;
  vars: string[];
  blocks: string[];
  /** 每一项里任意一个变量在正文里出现即可 */
  required: string[][];
  system: MailTemplate;
};

export const MAIL_TEMPLATE_DEFS: Record<MailTemplateKey, TemplateDef> = {
  delivery: {
    label: "发货邮件",
    hint: "付款后发货完成时发给买家，里面有卡密或账号。",
    vars: ["shop", "order_no", "product", "quantity", "paid_at", "buyer_email", "query_url"],
    blocks: ["items", "after_sales", "invite"],
    required: [["items"], ["after_sales"]],
    system: {
      subject: "{{shop}} {{order_no}}",
      body: "订单号 {{order_no}}\n\n{{items}}\n\n{{after_sales}}\n\n{{invite}}",
    },
  },
  order_links: {
    label: "查单链接",
    hint: "买家在店铺里按邮箱找订单时发，里面是他在本店最近的订单。",
    vars: ["shop", "buyer_email"],
    blocks: ["order_links", "after_sales"],
    required: [["order_links"], ["after_sales"]],
    system: {
      subject: "{{shop}} 查单链接",
      body: "下面是你在本店的订单，点链接查看卡密和发货状态。不是你本人操作的请忽略这封邮件。\n\n{{order_links}}\n\n{{after_sales}}",
    },
  },
  coupon_notice: {
    label: "邀请券到账",
    hint: "买家邀请的好友下单成功后发。",
    vars: ["shop", "buyer_email", "coupon_code", "coupon_scope", "coupon_expires_at", "shop_url"],
    blocks: ["coupon_usage"],
    required: [["coupon_code", "coupon_usage"]],
    system: {
      subject: "{{shop}} 邀请券到账",
      body: "你邀请的好友在本店下单成功，送你一张邀请券：\n\n{{coupon_usage}}",
    },
  },
  coupon_remind: {
    label: "邀请券到期",
    hint: "券还剩 3 天到期、买家还没用时发一次。",
    vars: ["shop", "buyer_email", "coupon_code", "coupon_scope", "coupon_expires_at", "shop_url"],
    blocks: ["coupon_usage"],
    required: [["coupon_code", "coupon_usage"]],
    system: {
      subject: "{{shop}} 邀请券快到期了",
      body: "你在本店的邀请券还没用，3 天内就要到期了：\n\n{{coupon_usage}}",
    },
  },
};

export const MAIL_VAR_LABEL: Record<string, string> = {
  shop: "店名",
  order_no: "订单号",
  product: "商品",
  quantity: "数量",
  paid_at: "付款时间",
  buyer_email: "买家邮箱",
  query_url: "查单链接",
  coupon_code: "券码",
  coupon_scope: "可用范围",
  coupon_expires_at: "到期时间",
  shop_url: "店铺地址",
  items: "卡密",
  after_sales: "售后联系",
  invite: "邀请好友",
  order_links: "订单列表",
  coupon_usage: "券码和用法",
};

export const AFTER_SALES_SYSTEM = { title: "售后联系", intro: "卡密或账号有任何问题，请直接联系店主处理：" };

export function isMailTemplateKey(value: unknown): value is MailTemplateKey {
  return (MAIL_TEMPLATE_KEYS as readonly unknown[]).includes(value);
}

// —— 渲染用的数据 ——

export type MailContact = { label: string; value: string; href: string };
export type AfterSalesBlock = { title: string; intro: string; contacts: MailContact[] };
export type InviteBlock = { rule: string; link: string; code: string };
export type OrderLink = { product: string; orderNo: string; url: string };
export type CouponBlock = { code: string; scope: string; expiresAt: string; maskedEmail: string; shopUrl: string };

export type MailContext = {
  vars: Record<string, string>;
  items?: string[];
  afterSales?: AfterSalesBlock | null;
  invite?: InviteBlock | null;
  orders?: OrderLink[];
  coupon?: CouponBlock | null;
};

export type RenderedMail = { subject: string; html: string; text: string };

// —— 校验 ——

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

function usedVars(text: string) {
  return [...String(text || "").matchAll(VAR_RE)].map((m) => m[1]);
}

export type TemplateCheck = { errors: string[]; required: Array<{ label: string; ok: boolean }> };

export function validateMailTemplate(key: MailTemplateKey, template: MailTemplate): TemplateCheck {
  const def = MAIL_TEMPLATE_DEFS[key];
  const known = new Set([...def.vars, ...def.blocks]);
  const errors: string[] = [];
  const push = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
  };
  const subject = template.subject ?? "";
  const body = template.body ?? "";
  for (const name of [...usedVars(subject), ...usedVars(body)]) {
    if (!known.has(name)) push(`不认识的变量 {{${name}}}`);
  }
  for (const name of usedVars(subject)) {
    if (def.blocks.includes(name)) push(`标题里不能放 {{${name}}}`);
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    for (const block of def.blocks) {
      if (new RegExp(`\\{\\{\\s*${block}\\s*\\}\\}`).test(trimmed) && !blockLine(trimmed)) {
        push(`{{${block}}} 要单独占一行`);
      }
    }
  }
  const bodyVars = new Set(usedVars(body));
  const required = def.required.map((names) => ({
    label: names.map((name) => `{{${name}}}`).join(" 或 "),
    ok: names.some((name) => bodyVars.has(name)),
  }));
  for (const item of required) if (!item.ok) push(`必须保留 ${item.label}`);
  if (!subject.trim()) push("标题不能为空");
  if (subject.length > MAIL_SUBJECT_MAX) push(`标题最多 ${MAIL_SUBJECT_MAX} 字`);
  if (/[\r\n]/.test(subject)) push("标题不能换行");
  if (body.length > MAIL_BODY_MAX) push(`正文最多 ${MAIL_BODY_MAX} 字`);
  return { errors, required };
}

function blockLine(trimmed: string) {
  const m = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(trimmed);
  return m ? m[1] : null;
}

// —— 渲染 ——

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 模板里写的链接只认 http(s)。变量代进去之后再判断，变量拼不出 javascript: 之类。 */
function safeUrl(url: string) {
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : "";
}

function fillVars(text: string, vars: Record<string, string>) {
  return String(text || "").replace(VAR_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? "") : whole,
  );
}

const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif";
const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
const MUTED = "color:#6a737d;";
const LINK = "color:#1f6feb;text-decoration:underline;word-break:break-all;";
const BOX = "padding:14px 16px;border:1px solid #e3e6ea;border-radius:10px;background:#f7f8fa;";
const BOX_TITLE = "margin:0 0 8px;font-size:13px;font-weight:600;color:#1f2328;";

function anchor(href: string, labelHtml: string) {
  return `<a href="${escapeHtml(href)}" style="${LINK}" target="_blank" rel="noopener">${labelHtml}</a>`;
}

function boldHtml(escaped: string) {
  return escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

const INLINE_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g;

/** 一行正文：先代变量，再转义，再处理加粗和链接。 */
function inlineHtml(raw: string, vars: Record<string, string>) {
  const text = fillVars(raw, vars);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_LINK_RE)) {
    out += boldHtml(escapeHtml(text.slice(last, m.index)));
    const label = m[1] ?? m[3];
    const url = safeUrl(m[2] ?? m[3]);
    out += url ? anchor(url, boldHtml(escapeHtml(label))) : boldHtml(escapeHtml(m[0]));
    last = (m.index ?? 0) + m[0].length;
  }
  return out + boldHtml(escapeHtml(text.slice(last)));
}

function inlineText(raw: string, vars: Record<string, string>) {
  return fillVars(raw, vars)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => (safeUrl(url) ? `${label}：${url}` : label))
    .replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

function contactValueHtml(contact: MailContact) {
  const value = escapeHtml(contact.value);
  if (/^mailto:/i.test(contact.href)) return anchor(contact.href, value);
  const url = safeUrl(contact.href);
  return url ? anchor(url, value) : value;
}

function blockHtml(name: string, ctx: MailContext): string {
  if (name === "items") {
    const items = ctx.items ?? [];
    if (!items.length) return "";
    return (
      `<p style="margin:0 0 8px;font-size:13px;${MUTED}">${items.length > 1 ? `共 ${items.length} 张` : "卡密"}</p>` +
      items
        .map(
          (code) =>
            `<div style="margin:0 0 8px;padding:12px 14px;border:1px dashed #c9d1d9;border-radius:8px;background:#f6f8fa;${MONO}font-size:15px;letter-spacing:0.02em;color:#1f2328;word-break:break-all;">${escapeHtml(code)}</div>`,
        )
        .join("")
    );
  }
  if (name === "after_sales") {
    const block = ctx.afterSales;
    if (!block?.contacts.length) return "";
    const rows = block.contacts
      .map(
        (c) =>
          `<tr><td style="padding:3px 16px 3px 0;font-size:14px;white-space:nowrap;vertical-align:top;${MUTED}">${escapeHtml(c.label)}</td>` +
          `<td style="padding:3px 0;font-size:14px;color:#1f2328;word-break:break-all;">${contactValueHtml(c)}</td></tr>`,
      )
      .join("");
    return (
      `<div style="${BOX}"><p style="${BOX_TITLE}">${escapeHtml(block.title)}</p>` +
      (block.intro ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;${MUTED}">${escapeHtml(block.intro)}</p>` : "") +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table></div>`
    );
  }
  if (name === "invite") {
    const invite = ctx.invite;
    if (!invite) return "";
    const link = safeUrl(invite.link);
    return (
      `<div style="${BOX}background:#fbf8ef;border-color:#efe3c2;"><p style="${BOX_TITLE}">邀请好友，得邀请券</p>` +
      `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#4b4f55;">${escapeHtml(invite.rule)}</p>` +
      (link ? `<p style="margin:0 0 6px;font-size:13px;">${anchor(link, escapeHtml(link))}</p>` : "") +
      `<p style="margin:0;font-size:12px;${MUTED}">好友没点链接的话，下单时填邀请码 <strong style="${MONO}color:#1f2328;">${escapeHtml(invite.code)}</strong> 也行。</p></div>`
    );
  }
  if (name === "order_links") {
    const orders = ctx.orders ?? [];
    if (!orders.length) return "";
    return (
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">` +
      orders
        .map((o) => {
          const url = safeUrl(o.url);
          return (
            `<tr><td style="padding:12px 0;border-top:1px solid #eef0f2;">` +
            `<div style="font-size:14px;font-weight:600;color:#1f2328;">${escapeHtml(o.product)}</div>` +
            `<div style="margin-top:2px;font-size:12px;${MONO}${MUTED}">${escapeHtml(o.orderNo)}</div></td>` +
            `<td align="right" style="padding:12px 0 12px 12px;border-top:1px solid #eef0f2;white-space:nowrap;">` +
            (url
              ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:7px 14px;border-radius:999px;background:#1f2328;color:#ffffff;font-size:13px;text-decoration:none;">查看</a>`
              : "") +
            `</td></tr>`
          );
        })
        .join("") +
      `</table>`
    );
  }
  if (name === "coupon_usage") {
    const c = ctx.coupon;
    if (!c) return "";
    const shopUrl = safeUrl(c.shopUrl);
    return (
      `<div style="${BOX}text-align:center;"><p style="margin:0 0 4px;font-size:12px;${MUTED}">券码</p>` +
      `<p style="margin:0 0 10px;font-size:22px;font-weight:700;letter-spacing:0.06em;${MONO}color:#1f2328;">${escapeHtml(c.code)}</p>` +
      `<p style="margin:0;font-size:13px;line-height:1.7;color:#4b4f55;">可用于：${escapeHtml(c.scope)}<br>有效期至 ${escapeHtml(c.expiresAt)}（北京时间）</p></div>` +
      `<p style="margin:12px 0 0;font-size:13px;line-height:1.7;${MUTED}">${escapeHtml(couponHowTo(c))}</p>` +
      (shopUrl ? `<p style="margin:6px 0 0;font-size:13px;">${anchor(shopUrl, escapeHtml(shopUrl))}</p>` : "")
    );
  }
  return "";
}

function couponHowTo(c: CouponBlock) {
  return `下次在本店下单时，在「优惠券」里填券码。下单邮箱要用这个邮箱（${c.maskedEmail}），别的邮箱用不了。`;
}

function blockText(name: string, ctx: MailContext): string {
  if (name === "items") return (ctx.items ?? []).join("\n");
  if (name === "after_sales") {
    const block = ctx.afterSales;
    if (!block?.contacts.length) return "";
    return [block.title, block.intro, ...block.contacts.map((c) => `${c.label}：${c.value}`)].filter(Boolean).join("\n");
  }
  if (name === "invite") {
    const invite = ctx.invite;
    if (!invite) return "";
    return [
      "————————",
      "邀请好友，得邀请券",
      invite.rule,
      invite.link,
      `好友没点链接的话，下单时填邀请码 ${invite.code} 也行。`,
    ].join("\n");
  }
  if (name === "order_links") {
    return (ctx.orders ?? []).map((o) => `${o.product}  订单号 ${o.orderNo}\n${o.url}`).join("\n\n");
  }
  if (name === "coupon_usage") {
    const c = ctx.coupon;
    if (!c) return "";
    return [`券码 ${c.code}`, `可用于：${c.scope}`, `有效期至 ${c.expiresAt}（北京时间）`, "", couponHowTo(c), c.shopUrl]
      .filter((line, index, list) => line || (index > 0 && index < list.length - 1))
      .join("\n");
  }
  return "";
}

type Node = { type: "p"; lines: string[] } | { type: "hr" } | { type: "block"; name: string };

function parseBody(body: string, blocks: string[]): Node[] {
  const nodes: Node[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) nodes.push({ type: "p", lines: para });
    para = [];
  };
  for (const line of String(body || "").replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    const block = blockLine(trimmed);
    if (block && blocks.includes(block)) {
      flush();
      nodes.push({ type: "block", name: block });
    } else if (trimmed === "---") {
      flush();
      nodes.push({ type: "hr" });
    } else if (!trimmed) {
      flush();
    } else {
      para.push(trimmed);
    }
  }
  flush();
  return nodes;
}

/** 邮件外观：页头店名、白色内容卡片、页脚。表格布局 + 内联样式，各家邮箱都认。 */
export function mailLayoutHtml(shop: string, preheader: string, contentHtml: string) {
  const text = `font-family:${FONT};`;
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{margin:0;padding:0;}@media (max-width:620px){.km-mail-wrap{padding:12px 8px !important;}.km-mail-card{padding:20px 18px !important;}}</style>` +
    `</head><body style="margin:0;padding:0;background:#f2f3f5;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;"><tr><td class="km-mail-wrap" align="center" style="padding:28px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;border-collapse:separate;">` +
    `<tr><td style="padding:0 4px 12px;${text}font-size:16px;font-weight:700;color:#1f2328;">${escapeHtml(shop)}</td></tr>` +
    `<tr><td class="km-mail-card" style="padding:26px 28px;background:#ffffff;border:1px solid #e3e6ea;border-radius:12px;${text}font-size:15px;line-height:1.7;color:#1f2328;overflow-wrap:anywhere;">${contentHtml}</td></tr>` +
    `<tr><td style="padding:14px 4px 0;${text}font-size:12px;line-height:1.6;color:#8c959f;">这封邮件由 ${escapeHtml(shop)} 自动发送。</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/** 渲染一封信。纯文本版第一行是店名，和改模板之前的邮件一样。 */
export function renderMailTemplate(key: MailTemplateKey, template: MailTemplate, ctx: MailContext): RenderedMail {
  const def = MAIL_TEMPLATE_DEFS[key];
  const vars = ctx.vars;
  const html: string[] = [];
  const text: string[] = [];
  for (const node of parseBody(template.body, def.blocks)) {
    if (node.type === "p") {
      html.push(`<p style="margin:0 0 14px;">${node.lines.map((line) => inlineHtml(line, vars)).join("<br>")}</p>`);
      text.push(node.lines.map((line) => inlineText(line, vars)).join("\n"));
    } else if (node.type === "hr") {
      html.push(`<hr style="margin:18px 0;border:0;border-top:1px solid #eef0f2;">`);
      text.push("————————");
    } else {
      const h = blockHtml(node.name, ctx);
      const t = blockText(node.name, ctx);
      if (h) html.push(`<div style="margin:0 0 16px;">${h}</div>`);
      if (t) text.push(t);
    }
  }
  const shop = vars.shop || "";
  const subject = inlineText(template.subject, vars).replace(/\s+/g, " ").trim().slice(0, 200);
  const plain = [shop, ...text].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
  return { subject, html: mailLayoutHtml(shop, subject, html.join("")), text: plain };
}

// —— 预览用的示例数据 ——

const AT = String.fromCharCode(64);

export function sampleMailContext(input: { shop: string; afterSales: AfterSalesBlock | null; origin?: string }): MailContext {
  const origin = (input.origin || "https://shop.example.com").replace(/\/+$/, "");
  const orderNo = "KS202610201330AB12CD34";
  return {
    vars: {
      shop: input.shop,
      order_no: orderNo,
      product: "ChatGPT Plus 月卡",
      quantity: "1",
      paid_at: "2026-10-20 13:30",
      buyer_email: `buyer${AT}example.com`,
      query_url: `${origin}/shop/order/${orderNo}?t=7f3a9c`,
      coupon_code: "INV-8K2M-Q7",
      coupon_scope: "Plus 月卡减 ¥5",
      coupon_expires_at: "2026-11-19 23:59",
      shop_url: `${origin}/s/demo`,
    },
    items: ["KMQ7-4FXB-92HD-L3PA"],
    afterSales: input.afterSales,
    invite: { rule: "好友用你的链接首次下单，你得一张 ¥5 邀请券。", link: `${origin}/s/demo?ref=K7Q2`, code: "K7Q2" },
    orders: [
      { product: "ChatGPT Plus 月卡", orderNo, url: `${origin}/shop/order/${orderNo}?t=7f3a9c` },
      { product: "Claude Pro 月卡", orderNo: "KS202610121102CD98EF10", url: `${origin}/shop/order/KS202610121102CD98EF10?t=19be42` },
    ],
    coupon: {
      code: "INV-8K2M-Q7",
      scope: "Plus 月卡减 ¥5",
      expiresAt: "2026-11-19 23:59",
      maskedEmail: `b***${AT}example.com`,
      shopUrl: `${origin}/s/demo`,
    },
  };
}

// —— 售后联系区块 ——

/** 代理的售后联系设置。店铺装修里的联系方式默认都显示，hidden 里记的是取消勾选的那些。 */
export type AfterSalesConfig = {
  title: string;
  intro: string;
  /** 店铺联系方式里不在邮件显示的，contactKey 格式 */
  hidden: string[];
  /** 只在邮件里用的联系方式 */
  extra: Array<{ type: ContactType; value: string }>;
};

export const AFTER_SALES_EXTRA_MAX = 5;
const MAIL_CONTACT_TYPES: readonly ContactType[] = ["telegram", "wechat", "qq", "email", "link"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function contactKey(contact: { type: string; value: string }) {
  return `${contact.type}:${contact.value.trim()}`;
}

function toContactItem(extra: { type: ContactType; value: string }): ContactItem {
  return { type: extra.type, value: extra.value.trim(), label: { zh: "", en: "" } };
}

function mailContact(contact: ContactItem): MailContact {
  return {
    label: contact.label.zh.trim() || contactTypeLabel(contact.type),
    value: contact.value.trim(),
    href: contactHref(contact) || "",
  };
}

/** 邮件里实际显示的联系方式：店铺装修里没取消勾选的 + 邮件专用的，格式不对的去掉，微信 / QQ / TG 排前面。 */
export function afterSalesVisibleContacts(config: AfterSalesConfig, shopContacts: ContactItem[]) {
  const hidden = new Set(config.hidden);
  return afterSalesContacts([
    ...shopContacts.filter((contact) => !hidden.has(contactKey(contact))),
    ...config.extra.map(toContactItem),
  ]);
}

/**
 * 发信用的售后区块。代理设置的联系方式里一个有效微信 / QQ / TG 都没有时（比如后来改了店铺联系方式），
 * 退回显示店铺装修里全部的联系方式，买家不能找不到人。
 */
export function buildAfterSalesBlock(config: AfterSalesConfig, shopContacts: ContactItem[]): AfterSalesBlock {
  let contacts = afterSalesVisibleContacts(config, shopContacts);
  if (!hasSupportContact(contacts)) contacts = afterSalesContacts(shopContacts);
  return {
    title: config.title.trim() || AFTER_SALES_SYSTEM.title,
    intro: config.intro.trim(),
    contacts: contacts.map(mailContact),
  };
}

function extraContactError(extra: { type: string; value: string }) {
  const value = String(extra.value ?? "").trim();
  if (!MAIL_CONTACT_TYPES.includes(extra.type as ContactType)) return "联系方式类型不对";
  if (!value) return "联系方式不能为空";
  if (value.length > 120) return "联系方式太长";
  if (extra.type === "email") return EMAIL_RE.test(value) ? null : "邮箱格式不对";
  if (extra.type === "link") return /^https?:\/\/\S+$/i.test(value) ? null : "链接要以 http:// 或 https:// 开头";
  return contactValueError(extra.type as ContactType, value);
}

export function validateAfterSalesConfig(config: AfterSalesConfig, shopContacts: ContactItem[]): string[] {
  const errors: string[] = [];
  if (config.title.trim().length > AFTER_SALES_TITLE_MAX) errors.push(`标题最多 ${AFTER_SALES_TITLE_MAX} 字`);
  if (config.intro.trim().length > AFTER_SALES_INTRO_MAX) errors.push(`说明最多 ${AFTER_SALES_INTRO_MAX} 字`);
  if (config.extra.length > AFTER_SALES_EXTRA_MAX) errors.push(`邮件专用的联系方式最多 ${AFTER_SALES_EXTRA_MAX} 个`);
  for (const extra of config.extra) {
    const error = extraContactError(extra);
    if (error) errors.push(`${contactTypeLabel(extra.type)} ${extra.value.trim()}：${error}`);
  }
  if (!hasSupportContact(afterSalesVisibleContacts(config, shopContacts))) {
    errors.push("至少要留一个微信、QQ 或 Telegram，买家有问题才找得到你");
  }
  return errors;
}

/** 存库的 JSON 读回来。坏数据退回默认，不让发信失败。 */
export function parseAfterSalesConfig(raw: string | null | undefined, fallback = AFTER_SALES_SYSTEM): AfterSalesConfig {
  let value: Partial<AfterSalesConfig> = {};
  try {
    value = JSON.parse(raw || "{}") as Partial<AfterSalesConfig>;
  } catch {
    value = {};
  }
  return {
    title: typeof value.title === "string" ? value.title : fallback.title,
    intro: typeof value.intro === "string" ? value.intro : fallback.intro,
    hidden: Array.isArray(value.hidden) ? value.hidden.filter((item): item is string => typeof item === "string") : [],
    extra: Array.isArray(value.extra)
      ? value.extra
          .filter((item) => item && typeof item.value === "string" && MAIL_CONTACT_TYPES.includes(item.type))
          .map((item) => ({ type: item.type, value: item.value }))
      : [],
  };
}
