import { describe, expect, it } from "vitest";
import type { ContactItem } from "./agent-storefront-config";
import {
  AFTER_SALES_SYSTEM,
  MAIL_TEMPLATE_DEFS,
  MAIL_TEMPLATE_KEYS,
  buildAfterSalesBlock,
  parseAfterSalesConfig,
  renderMailTemplate,
  sampleMailContext,
  validateAfterSalesConfig,
  validateMailTemplate,
  type AfterSalesConfig,
  type MailContext,
} from "./mail-template-core";

const AT = String.fromCharCode(64);
const contact = (type: ContactItem["type"], value: string, zh = ""): ContactItem => ({ type, value, label: { zh, en: "" } });
const shopContacts = [contact("wechat", "abc_shop2026"), contact("qq", "1234567890"), contact("email", `help${AT}abc.cn`)];
const config = (patch: Partial<AfterSalesConfig> = {}): AfterSalesConfig => ({ ...AFTER_SALES_SYSTEM, hidden: [], extra: [], ...patch });

/** 去掉空行后逐行比较：改模板前后只有空行位置可能不同。 */
const lines = (text: string) => text.split("\n").filter((line) => line.trim());

const deliveryCtx: MailContext = {
  vars: { shop: "测试店", order_no: "KS1", product: "Plus", quantity: "1", paid_at: "", buyer_email: "", query_url: "" },
  items: ["CODE-1", "CODE-2"],
  afterSales: buildAfterSalesBlock(config(), shopContacts),
  invite: { rule: "好友首单你得一张券。", link: "https://shop.example.com/s/demo?ref=K7", code: "K7" },
};

describe("系统默认模板 = 改模板之前的文案", () => {
  it("发货邮件", () => {
    const mail = renderMailTemplate("delivery", MAIL_TEMPLATE_DEFS.delivery.system, deliveryCtx);
    expect(mail.subject).toBe("测试店 KS1");
    expect(lines(mail.text)).toEqual(
      lines(
        [
          "测试店",
          "订单号 KS1",
          "",
          "CODE-1",
          "CODE-2",
          "",
          "售后联系",
          "卡密或账号有任何问题，请直接联系店主处理：",
          "微信：abc_shop2026",
          "QQ：1234567890",
          `售后邮箱：help${AT}abc.cn`,
          "",
          "————————",
          "邀请好友，得邀请券",
          "好友首单你得一张券。",
          "https://shop.example.com/s/demo?ref=K7",
          "好友没点链接的话，下单时填邀请码 K7 也行。",
        ].join("\n"),
      ),
    );
  });

  it("没有邀请、没有售后时整段去掉，不留多余空行", () => {
    const mail = renderMailTemplate("delivery", MAIL_TEMPLATE_DEFS.delivery.system, {
      ...deliveryCtx,
      invite: null,
      afterSales: { ...AFTER_SALES_SYSTEM, contacts: [] },
    });
    expect(mail.text).toBe("测试店\n\n订单号 KS1\n\nCODE-1\nCODE-2");
    expect(mail.html).not.toContain("邀请好友");
  });

  it("查单链接", () => {
    const mail = renderMailTemplate("order_links", MAIL_TEMPLATE_DEFS.order_links.system, {
      vars: { shop: "测试店", buyer_email: "" },
      orders: [{ product: "Plus", orderNo: "KS1", url: "https://s.example.com/o/KS1?t=1" }],
      afterSales: buildAfterSalesBlock(config(), [contact("wechat", "abc_shop2026")]),
    });
    expect(mail.subject).toBe("测试店 查单链接");
    expect(lines(mail.text)).toEqual([
      "测试店",
      "下面是你在本店的订单，点链接查看卡密和发货状态。不是你本人操作的请忽略这封邮件。",
      "Plus  订单号 KS1",
      "https://s.example.com/o/KS1?t=1",
      "售后联系",
      "卡密或账号有任何问题，请直接联系店主处理：",
      "微信：abc_shop2026",
    ]);
  });

  it("邀请券到账 / 到期", () => {
    const ctx: MailContext = {
      vars: { shop: "测试店" },
      coupon: { code: "INV-1", scope: "Plus 立减 ¥10.00", expiresAt: "2026-11-19 23:59", maskedEmail: `w***${AT}qq.com`, shopUrl: "https://s.example.com/s/a" },
    };
    const notice = renderMailTemplate("coupon_notice", MAIL_TEMPLATE_DEFS.coupon_notice.system, ctx);
    expect(notice.subject).toBe("测试店 邀请券到账");
    expect(notice.text).toBe(
      [
        "测试店",
        "",
        "你邀请的好友在本店下单成功，送你一张邀请券：",
        "",
        "券码 INV-1",
        "可用于：Plus 立减 ¥10.00",
        "有效期至 2026-11-19 23:59（北京时间）",
        "",
        `下次在本店下单时，在「优惠券」里填券码。下单邮箱要用这个邮箱（w***${AT}qq.com），别的邮箱用不了。`,
        "https://s.example.com/s/a",
      ].join("\n"),
    );
    expect(renderMailTemplate("coupon_remind", MAIL_TEMPLATE_DEFS.coupon_remind.system, ctx).subject).toBe("测试店 邀请券快到期了");
  });

  it("每个系统默认模板自己能通过校验", () => {
    for (const key of MAIL_TEMPLATE_KEYS) {
      expect(validateMailTemplate(key, MAIL_TEMPLATE_DEFS[key].system).errors).toEqual([]);
    }
  });
});

describe("校验", () => {
  const ok = MAIL_TEMPLATE_DEFS.delivery.system;

  it("必须保留卡密和售后联系", () => {
    expect(validateMailTemplate("delivery", { ...ok, body: "{{items}}" }).errors).toContain("必须保留 {{after_sales}}");
    expect(validateMailTemplate("delivery", { ...ok, body: "{{after_sales}}" }).errors).toContain("必须保留 {{items}}");
  });

  it("邀请券保留券码或券码区块其一即可", () => {
    expect(validateMailTemplate("coupon_notice", { subject: "x", body: "你的券 {{coupon_code}}" }).errors).toEqual([]);
    expect(validateMailTemplate("coupon_notice", { subject: "x", body: "没有券" }).errors).toContain(
      "必须保留 {{coupon_code}} 或 {{coupon_usage}}",
    );
  });

  it("不认识的变量、区块没单独占一行、标题里放区块都不行", () => {
    const errors = validateMailTemplate("delivery", {
      subject: "{{shop}} {{items}}",
      body: "{{prodcut}}\n售后加我 {{after_sales}}\n{{items}}",
    }).errors;
    expect(errors).toContain("不认识的变量 {{prodcut}}");
    expect(errors).toContain("{{after_sales}} 要单独占一行");
    expect(errors).toContain("标题里不能放 {{items}}");
  });

  it("别的邮件的变量在这封里不认识", () => {
    expect(validateMailTemplate("order_links", { subject: "x", body: "{{order_no}}\n{{order_links}}\n{{after_sales}}" }).errors).toContain(
      "不认识的变量 {{order_no}}",
    );
  });

  it("标题必填、长度上限、不能换行", () => {
    expect(validateMailTemplate("delivery", { ...ok, subject: " " }).errors).toContain("标题不能为空");
    expect(validateMailTemplate("delivery", { ...ok, subject: "x".repeat(121) }).errors).toContain("标题最多 120 字");
    expect(validateMailTemplate("delivery", { ...ok, subject: "a\nb" }).errors).toContain("标题不能换行");
    expect(validateMailTemplate("delivery", { ...ok, body: `${ok.body}\n${"x".repeat(5000)}` }).errors).toContain("正文最多 5000 字");
  });
});

describe("HTML 安全", () => {
  const sample = sampleMailContext({ shop: "测试店", afterSales: buildAfterSalesBlock(config(), shopContacts) });

  it("代理写的文字、变量值都转义", () => {
    const mail = renderMailTemplate(
      "delivery",
      { subject: "x", body: "<script>alert(1)</script> **{{product}}**\n{{items}}\n{{after_sales}}" },
      { ...sample, vars: { ...sample.vars, product: "<img src=x onerror=alert(1)>" } },
    );
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("<strong>&lt;img src=x onerror=alert(1)&gt;</strong>");
  });

  it("链接只认 http(s)，变量代进去以后再判断", () => {
    const mail = renderMailTemplate(
      "delivery",
      {
        subject: "x",
        body: "[点我](javascript:alert(1))\n[查单](https://my.example.com/q?no={{order_no}})\n[坏](https://x\" onmouseover=\"y)\n{{items}}\n{{after_sales}}",
      },
      sample,
    );
    expect(mail.html).not.toMatch(/href="javascript/i);
    expect(mail.html).toContain(`href="https://my.example.com/q?no=${sample.vars.order_no}"`);
    expect(mail.html).not.toContain("onmouseover=\"");
    expect(mail.text).toContain(`查单：https://my.example.com/q?no=${sample.vars.order_no}`);
    expect(mail.text).toContain("点我");
    expect(mail.text).not.toContain("javascript:");
  });

  it("加粗、分隔线、裸网址", () => {
    const mail = renderMailTemplate("delivery", { subject: "x", body: "**重要**\n---\n教程 https://docs.example.com/a\n{{items}}\n{{after_sales}}" }, sample);
    expect(mail.html).toContain("<strong>重要</strong>");
    expect(mail.html).toContain("<hr");
    expect(mail.html).toContain('href="https://docs.example.com/a"');
    expect(mail.text).toContain("————————");
    expect(mail.text).not.toContain("**");
  });
});

describe("售后联系", () => {
  it("取消勾选的不显示，邮件专用的加进来，微信 / QQ / TG 排前面", () => {
    const block = buildAfterSalesBlock(
      config({ title: "有问题找我", hidden: ["qq:1234567890"], extra: [{ type: "telegram", value: "@shop_help" }] }),
      shopContacts,
    );
    expect(block.title).toBe("有问题找我");
    expect(block.contacts.map((c) => c.value)).toEqual(["abc_shop2026", "@shop_help", `help${AT}abc.cn`]);
    expect(block.contacts[1].href).toBe("https://t.me/shop_help");
  });

  it("一个有效的微信 / QQ / TG 都没留不能保存", () => {
    expect(validateAfterSalesConfig(config({ hidden: ["wechat:abc_shop2026", "qq:1234567890"] }), shopContacts)).toContain(
      "至少要留一个微信、QQ 或 Telegram，买家有问题才找得到你",
    );
    expect(validateAfterSalesConfig(config({ hidden: ["wechat:abc_shop2026"] }), shopContacts)).toEqual([]);
  });

  it("邮件专用联系方式校验格式", () => {
    const errors = validateAfterSalesConfig(
      config({ extra: [{ type: "qq", value: "abc" }, { type: "link", value: "javascript:x" }] }),
      shopContacts,
    );
    expect(errors.some((e) => e.includes("QQ 号格式不对"))).toBe(true);
    expect(errors.some((e) => e.includes("链接要以 http"))).toBe(true);
  });

  it("后来店铺联系方式变了、代理选的都失效时，退回显示店铺全部联系方式", () => {
    const block = buildAfterSalesBlock(config({ hidden: ["wechat:abc_shop2026", "qq:1234567890"] }), shopContacts);
    expect(block.contacts.map((c) => c.value)).toContain("abc_shop2026");
  });

  it("用店铺装修里写的名称，没写用类型名；一个联系方式都没有时区块整段不出现", () => {
    const block = buildAfterSalesBlock(config(), [contact("qq", "123456"), contact("wechat", "kaimi_help", "售后微信")]);
    expect(block.contacts.map((c) => `${c.label}：${c.value}`)).toEqual(["QQ：123456", "售后微信：kaimi_help"]);
    const empty = renderMailTemplate("delivery", MAIL_TEMPLATE_DEFS.delivery.system, {
      ...deliveryCtx,
      afterSales: buildAfterSalesBlock(config(), []),
    });
    expect(empty.text).not.toContain("售后联系");
  });

  it("存库的坏数据退回默认", () => {
    expect(parseAfterSalesConfig("not json")).toEqual(config());
    expect(parseAfterSalesConfig(JSON.stringify({ title: "T", extra: [{ type: "bad", value: "x" }] }))).toEqual(config({ title: "T" }));
  });
});
