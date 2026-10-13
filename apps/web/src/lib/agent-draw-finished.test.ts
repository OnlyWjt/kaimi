import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库走一遍提成品号：迁移、领号、账本、作废。库文件固定名字，每次运行先删掉重建。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: dir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = joinPath(dir(), "kaimi-draw-finished-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));
vi.mock("@/lib/notify", () => ({
  notifyDrawAlert: vi.fn(async () => null),
  notifyDrawApply: vi.fn(async () => null),
  notifyDrawCreated: vi.fn(async () => null),
}));

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  draw: typeof import("./agent-draw");
  config: typeof import("./config");
  crypto: typeof import("./crypto");
  orm: typeof import("drizzle-orm");
};
let m: Modules;
const admin = { id: 1, role: "super_admin" as const };
let finishedPlanId = 0;
let seq = 0;

async function seedAgent(input: { allowFinished: boolean; maxPerDraw?: number; creditCents?: number }) {
  const { db, schema } = m;
  seq += 1;
  const [agent] = await db
    .insert(schema.agents)
    .values({ displayName: `代理${seq}`, currentSlug: `agent-${seq}` })
    .returning();
  await db.insert(schema.agentPlanPrices).values({
    agentId: agent.id,
    planId: finishedPlanId,
    drawPriceCents: 3500,
    enabled: true,
  });
  await db.insert(schema.agentDrawAccess).values({
    agentId: agent.id,
    status: "approved",
    creditLimitCents: input.creditCents ?? 1_000_000,
    maxPerDraw: input.maxPerDraw ?? 10,
    allowFinished: input.allowFinished,
  });
  return agent.id;
}

async function seedAccounts(count: number, costCents: number | null = 300) {
  const { db, crypto } = m;
  const rows = Array.from({ length: count }, () => {
    seq += 1;
    return {
      planKey: "finished_gpt",
      email: `acct${seq}@example.com`,
      gptPasswordEncrypted: crypto.encryptSecret(`gpt-${seq}`),
      mailboxPasswordEncrypted: crypto.encryptSecret(`mail-${seq}`),
      sessionEncrypted: crypto.encryptSecret(`session-${seq}-${"x".repeat(24)}`),
      costCents,
    };
  });
  return db.insert(m.schema.finishedAccounts).values(rows).returning();
}

/** 每个用例从干净库存开始：把之前剩下的未售号都停掉。 */
async function clearStock() {
  const { db, schema, orm } = m;
  await db
    .update(schema.finishedAccounts)
    .set({ status: "disabled" })
    .where(orm.eq(schema.finishedAccounts.status, "unused"));
  await m.config.setSetting("draw_finished_reserve", "0");
}

beforeAll(async () => {
  m = {
    db: (await import("@/db")).db,
    schema: await import("@/db/schema"),
    draw: await import("./agent-draw"),
    config: await import("./config"),
    crypto: await import("./crypto"),
    orm: await import("drizzle-orm"),
  };
  // 迁移在空库上跑不通（老问题：账本迁移先于提卡建表），所以先按 Drizzle schema 建全表，
  // 再跑一遍 bootDb，和线上已有库升级的路径一样。
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api");
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(m.schema as unknown as Record<string, unknown>),
  );
  const { client } = await import("@/db");
  for (const statement of statements) await client.execute(statement);
  await m.config.bootDb();
  const plan = await m.db.query.platformPlans.findFirst({
    where: m.orm.eq(m.schema.platformPlans.planKey, "finished_gpt"),
  });
  if (!plan) throw new Error("迁移没有建 finished_gpt 套餐");
  finishedPlanId = plan.id;
}, 60_000);

afterAll(async () => {
  (await import("@/db")).client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行开头会删 */
    }
  }
  void tmpdir;
  void join;
});

describe("提成品号", () => {
  it("没开通的代理看不到、也提不了", async () => {
    await clearStock();
    await seedAccounts(3);
    const agentId = await seedAgent({ allowFinished: false });
    const state = await m.draw.getAgentDrawState(agentId);
    expect(state.plans?.some((plan) => plan.planKey === "finished_gpt")).toBe(false);
    await expect(
      m.draw.createDrawOrder(agentId, { requestId: "req-closed-1", planKey: "finished_gpt", quantity: 1 }),
    ).rejects.toThrow("不在你的可提范围里");
  });

  it("开通后列表里有成品号和可提数，扣掉商城保留数", async () => {
    await clearStock();
    await seedAccounts(10);
    await m.config.setSetting("draw_finished_reserve", "8");
    const agentId = await seedAgent({ allowFinished: true });
    const state = await m.draw.getAgentDrawState(agentId);
    const plan = state.plans?.find((item) => item.planKey === "finished_gpt");
    expect(plan).toMatchObject({ fulfillmentKind: "local_account", availableStock: 2, unitPriceCents: 3500 });

    await expect(
      m.draw.createDrawOrder(agentId, { requestId: "req-reserve-1", planKey: "finished_gpt", quantity: 3 }),
    ).rejects.toThrow("最多能提 2 个");
    // 被拒的单什么都没写
    const orders = await m.db.query.agentDrawOrders.findMany({
      where: m.orm.eq(m.schema.agentDrawOrders.agentId, agentId),
    });
    expect(orders).toHaveLength(0);
  });

  it("提 2 个：号变已售、账本两行、交付记录是 used、进价按号", async () => {
    await clearStock();
    const [a, b] = await seedAccounts(2, 280);
    const agentId = await seedAgent({ allowFinished: true });
    const result = await m.draw.createDrawOrder(agentId, {
      requestId: "req-ok-1",
      planKey: "finished_gpt",
      quantity: 2,
    });
    expect(result.status).toBe("delivered");
    expect(result.fulfillmentKind).toBe("local_account");
    expect(result.issuedCount).toBe(2);
    expect(result.amountCents).toBe(7000);
    expect(result.accounts.map((row) => row.email).sort()).toEqual([a.email, b.email].sort());
    expect(result.accounts[0].session).toContain("session-");
    expect(result.codes[0].split("----")).toHaveLength(4);

    const { db, schema, orm } = m;
    const order = await db.query.agentDrawOrders.findFirst({
      where: orm.eq(schema.agentDrawOrders.drawNo, result.drawNo),
    });
    expect(order).toMatchObject({ cardplatformAccountId: 0, upstreamCostUnitCents: 280 });
    const accounts = await db.query.finishedAccounts.findMany({
      where: orm.inArray(schema.finishedAccounts.id, [a.id, b.id]),
    });
    expect(accounts.every((row) => row.status === "sold" && row.drawOrderId === order!.id)).toBe(true);
    expect(accounts.every((row) => row.storeOrderId == null)).toBe(true);
    const cdks = await db.query.issuedCdks.findMany({
      where: orm.eq(schema.issuedCdks.drawOrderId, order!.id),
    });
    expect(cdks).toHaveLength(2);
    expect(cdks.every((row) => row.status === "used" && row.upstreamRef.startsWith("finished:"))).toBe(true);
    const items = await db.query.agentDrawItems.findMany({
      where: orm.eq(schema.agentDrawItems.drawOrderId, order!.id),
    });
    expect(items.map((row) => [row.status, row.amountCents, row.upstreamCostCents])).toEqual([
      ["unsettled", 3500, 280],
      ["unsettled", 3500, 280],
    ]);

    // 未结算列表、对账文本按「个」
    const state = await m.draw.getAgentDrawState(agentId);
    expect(state.summary?.amountCents).toBe(7000);
    expect(state.statementText).toContain("合计 2 个");
    const ledger = await m.draw.listAgentUnsettledItems(agentId);
    expect(ledger.items.every((row) => row.finished && row.codeMasked.includes("****@example.com"))).toBe(true);
  });

  it("同一个 requestId 再提：返回同一批号，不再领", async () => {
    await clearStock();
    await seedAccounts(4);
    const agentId = await seedAgent({ allowFinished: true });
    const first = await m.draw.createDrawOrder(agentId, { requestId: "req-idem-1", planKey: "finished_gpt", quantity: 2 });
    const again = await m.draw.createDrawOrder(agentId, { requestId: "req-idem-1", planKey: "finished_gpt", quantity: 2 });
    expect(again.drawNo).toBe(first.drawNo);
    expect(again.accounts.map((row) => row.email)).toEqual(first.accounts.map((row) => row.email));
    const state = await m.draw.getAgentDrawState(agentId);
    expect(state.plans?.find((plan) => plan.planKey === "finished_gpt")?.availableStock).toBe(2);
  });

  it("邮箱已经发过的号跳过并停用，接着领下一个", async () => {
    await clearStock();
    const [dup, fresh] = await seedAccounts(2);
    const { db, schema, crypto, orm } = m;
    await db.insert(schema.issuedCdks).values({
      orderId: 999,
      agentId: 1,
      planKey: "finished_gpt",
      codeEncrypted: crypto.encryptSecret("manual"),
      codeHash: crypto.hashLookupValue(dup.email),
      cardplatformAccountId: 0,
      status: "used",
    });
    const agentId = await seedAgent({ allowFinished: true });
    // 库存显示 2，但其中 1 个撞车：提 1 个能成功，拿到的是没撞的那个
    const result = await m.draw.createDrawOrder(agentId, { requestId: "req-dup-1", planKey: "finished_gpt", quantity: 1 });
    expect(result.accounts.map((row) => row.email)).toEqual([fresh.email]);
    const dupRow = await db.query.finishedAccounts.findFirst({ where: orm.eq(schema.finishedAccounts.id, dup.id) });
    expect(dupRow?.status).toBe("disabled");
  });

  it("作废成品号：不调卡台、账号停用不回库存、金额从未结里扣掉", async () => {
    await clearStock();
    const [account] = await seedAccounts(1);
    const agentId = await seedAgent({ allowFinished: true });
    await m.draw.createDrawOrder(agentId, { requestId: "req-void-1", planKey: "finished_gpt", quantity: 1 });
    const { items } = await m.draw.listAgentUnsettledItems(agentId);
    await expect(
      m.draw.voidDrawItem({ itemId: items[0].id, mode: "upstream", reason: "误提" }, admin),
    ).rejects.toThrow("只能选「只在本系统作废」");
    await expect(m.draw.manualUseDrawItem({ itemId: items[0].id, reason: "x" }, admin)).rejects.toThrow(
      "不用手动核销",
    );
    await m.draw.voidDrawItem({ itemId: items[0].id, mode: "local", reason: "误提" }, admin);
    const { db, schema, orm } = m;
    const row = await db.query.finishedAccounts.findFirst({ where: orm.eq(schema.finishedAccounts.id, account.id) });
    expect(row?.status).toBe("disabled");
    const state = await m.draw.getAgentDrawState(agentId);
    expect(state.summary?.amountCents).toBe(0);
  });

  it("导出：只有自己的号，作废的不导出", async () => {
    await clearStock();
    await seedAccounts(2);
    const agentId = await seedAgent({ allowFinished: true });
    const other = await seedAgent({ allowFinished: true });
    const mine = await m.draw.createDrawOrder(agentId, { requestId: "req-exp-1", planKey: "finished_gpt", quantity: 1 });
    await m.draw.createDrawOrder(other, { requestId: "req-exp-2", planKey: "finished_gpt", quantity: 1 });
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    const rows = await m.draw.agentDrawExportRows(agentId, { from: today, to: today }, { id: agentId, role: "agent" });
    expect(rows.map((row) => row.drawNo)).toEqual([mine.drawNo]);
    expect(rows[0]).toMatchObject({ finished: true, useLabel: "已交付" });
    await expect(
      m.draw.agentDrawExportRows(agentId, { drawNo: (await m.draw.listAgentDrawOrders(other))[0].drawNo }, {
        id: agentId,
        role: "agent",
      }),
    ).rejects.toThrow("提取单不存在");

    const { items } = await m.draw.listAgentUnsettledItems(agentId);
    await m.draw.voidDrawItem({ itemId: items[0].id, mode: "local", reason: "误提" }, admin);
    const after = await m.draw.agentDrawExportRows(agentId, { drawNo: mine.drawNo }, { id: agentId, role: "agent" });
    expect(after).toHaveLength(0);
  });

  // 放最后：libsql 并发事务撞锁后，同一个 client 上紧接着的事务可能报 SQLITE_BUSY，会连累后面的用例。
  it("两个代理同时抢最后 1 个：只出一个号", async () => {
    await clearStock();
    const [last] = await seedAccounts(1);
    const one = await seedAgent({ allowFinished: true });
    const two = await seedAgent({ allowFinished: true });
    const results = await Promise.allSettled([
      m.draw.createDrawOrder(one, { requestId: "req-race-1", planKey: "finished_gpt", quantity: 1 }),
      m.draw.createDrawOrder(two, { requestId: "req-race-2", planKey: "finished_gpt", quantity: 1 }),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    // 输的那个要么读到库存不够，要么撞上写锁（SQLITE_BUSY，卡密提卡同样如此），都不会多领
    const rejected = results.find((row) => row.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toMatch(/库存|SQLITE_BUSY/);
    const { db, schema, orm } = m;
    const row = await db.query.finishedAccounts.findFirst({ where: orm.eq(schema.finishedAccounts.id, last.id) });
    expect(row?.status).toBe("sold");
    const items = await db.query.agentDrawItems.findMany({
      where: orm.inArray(schema.agentDrawItems.agentId, [one, two]),
    });
    expect(items).toHaveLength(1);
  });
});
