import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库：三层取模板、允许代理修改、售后联系读写都要落库才看得出对不对。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = join(tmpdir(), "kaimi-mail-template-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));

let tpl: typeof import("./mail-template");
let core: typeof import("./mail-template-core");
let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let seq = 0;

beforeAll(async () => {
  await (await import("./config")).bootDb();
  tpl = await import("./mail-template");
  core = await import("./mail-template-core");
  db = (await import("@/db")).db;
  schema = await import("@/db/schema");
});

afterAll(async () => {
  (await import("@/db")).client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行开头会删 */
    }
  }
});

async function makeAgent(contacts: Array<{ type: string; value: string }> = [{ type: "wechat", value: "abc_shop2026" }]) {
  seq += 1;
  const [agent] = await db
    .insert(schema.agents)
    .values({ displayName: `店${seq}`, currentSlug: `mail-tpl-${seq}` })
    .returning();
  await db.insert(schema.agentStorefronts).values({
    agentId: agent.id,
    contactsJson: JSON.stringify(contacts.map((c) => ({ ...c, label: { zh: "", en: "" } }))),
  });
  return agent.id;
}

const mine = { subject: "{{shop}} 我的标题", body: "我的正文\n{{items}}\n{{after_sales}}" };

describe("三层取模板", () => {
  it("没人改过用系统默认；平台改了用平台；代理改了用代理的", async () => {
    const agentId = await makeAgent();
    expect((await tpl.resolveMailTemplate("delivery", agentId)).layer).toBe("system");

    await tpl.savePlatformTemplate("delivery", { subject: "平台 {{order_no}}", body: "平台\n{{items}}\n{{after_sales}}" }, 1);
    expect(await tpl.resolveMailTemplate("delivery", agentId)).toMatchObject({ layer: "platform", template: { subject: "平台 {{order_no}}" } });

    await tpl.saveAgentTemplate(agentId, "delivery", mine, 1);
    expect(await tpl.resolveMailTemplate("delivery", agentId)).toMatchObject({ layer: "agent", template: mine });

    // 平台再改不影响已自定义的代理
    await tpl.savePlatformTemplate("delivery", { subject: "平台第二版", body: "{{items}}\n{{after_sales}}" }, 1);
    expect((await tpl.resolveMailTemplate("delivery", agentId)).template).toEqual(mine);

    // 恢复平台模板后跟着平台走
    await tpl.resetAgentTemplate(agentId, "delivery");
    expect((await tpl.resolveMailTemplate("delivery", agentId)).template.subject).toBe("平台第二版");

    await tpl.resetPlatformTemplate("delivery", 1);
    expect((await tpl.resolveMailTemplate("delivery", agentId)).layer).toBe("system");
  });

  it("关掉允许代理修改：代理的模板保留但不生效，也不能再存", async () => {
    const agentId = await makeAgent();
    await tpl.saveAgentTemplate(agentId, "order_links", { subject: "x", body: "{{order_links}}\n{{after_sales}}" }, 1);
    await tpl.setAgentEditable("order_links", false, 1);
    expect((await tpl.resolveMailTemplate("order_links", agentId)).layer).toBe("system");
    await expect(tpl.saveAgentTemplate(agentId, "order_links", { subject: "y", body: "{{order_links}}\n{{after_sales}}" }, 1)).rejects.toThrow(
      "平台统一了这封邮件的内容",
    );
    await tpl.setAgentEditable("order_links", true, 1);
    expect((await tpl.resolveMailTemplate("order_links", agentId)).template.subject).toBe("x");
  });

  it("不合格的模板存不进去", async () => {
    const agentId = await makeAgent();
    await expect(tpl.saveAgentTemplate(agentId, "delivery", { subject: "x", body: "{{items}}" }, 1)).rejects.toThrow("必须保留 {{after_sales}}");
    await expect(tpl.savePlatformTemplate("delivery", { subject: "", body: "{{items}}\n{{after_sales}}" }, 1)).rejects.toThrow("标题不能为空");
  });
});

describe("售后联系", () => {
  it("代理没设置时用平台默认文字、店铺联系方式全显示", async () => {
    const agentId = await makeAgent([{ type: "wechat", value: "abc_shop2026" }, { type: "qq", value: "1234567890" }]);
    await tpl.savePlatformAfterSales({ title: "售后", intro: "找店主" }, 1);
    const block = await tpl.loadAfterSalesBlock(agentId);
    expect(block).toMatchObject({ title: "售后", intro: "找店主" });
    expect(block.contacts.map((c) => c.value)).toEqual(["abc_shop2026", "1234567890"]);
  });

  it("代理改过：用自己的设置，至少留一个有效联系方式", async () => {
    const agentId = await makeAgent([{ type: "wechat", value: "abc_shop2026" }, { type: "qq", value: "1234567890" }]);
    await expect(
      tpl.saveAgentAfterSales(agentId, { title: "x", intro: "", hidden: ["wechat:abc_shop2026", "qq:1234567890"], extra: [] }, 1),
    ).rejects.toThrow("至少要留一个微信、QQ 或 Telegram");
    await tpl.saveAgentAfterSales(agentId, { title: "有问题找我", intro: "", hidden: ["qq:1234567890"], extra: [{ type: "telegram", value: "@shop_help" }] }, 1);
    const block = await tpl.loadAfterSalesBlock(agentId);
    expect(block.title).toBe("有问题找我");
    expect(block.contacts.map((c) => c.value)).toEqual(["abc_shop2026", "@shop_help"]);
  });

  it("渲染发货邮件时带上代理的售后联系", async () => {
    const agentId = await makeAgent();
    const mail = await tpl.renderShopMail("delivery", agentId, { vars: { shop: "店", order_no: "KS9" }, items: ["C-1"] });
    expect(mail.text).toContain("微信：abc_shop2026");
    expect(mail.html).toContain("C-1");
    expect(core.MAIL_TEMPLATE_KEYS).toContain("delivery");
  });
});

describe("管理员看到的列表", () => {
  it("列出改过模板的代理", async () => {
    const agentId = await makeAgent();
    await tpl.saveAgentTemplate(agentId, "coupon_notice", { subject: "x", body: "{{coupon_usage}}" }, 1);
    const snapshot = await tpl.adminMailTemplateSnapshot();
    expect(snapshot.templates.coupon_notice.customized.map((row) => row.agentId)).toContain(agentId);
    expect(snapshot.templates.delivery.system.subject).toBe("{{shop}} {{order_no}}");
  });
});
