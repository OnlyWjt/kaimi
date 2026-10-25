import { rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 真库走一遍代理自己作废提的卡：卡台删卡、记作废、每日上限、各种不能作废的情况。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: dir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = joinPath(dir(), "kaimi-draw-agent-void-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

const fake = vi.hoisted(() => ({
  seq: 0,
  deleted: [] as number[],
  /** 下一次删卡怎么失败：卡台报错 / 卡已不存在（404） */
  deleteFails: "" as "" | "error" | "missing",
  /** 删卡成功后、本地写账前插一脚：模拟这期间卡被拉进对账、状态变了 */
  afterDelete: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));
vi.mock("@/lib/notify", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const stubbed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(original)) {
    stubbed[name] = typeof value === "function" ? vi.fn(async () => null) : value;
  }
  return stubbed;
});
vi.mock("@/lib/cardplatform/policy", () => ({ issuePrefFromAccount: async () => null }));
vi.mock("@/lib/cardplatform/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("./cardplatform/config")>();
  const { CardplatformError } = await import("./cardplatform/client");
  const account = () => ({ id: 1, protocol: "spacexcard-legacy", enabled: true, siteBase: "https://card.test" });
  const client = {
    async issueMany(plan: string, count: number) {
      return Array.from({ length: count }, () => {
        fake.seq += 1;
        const code = `ZC-VOID${String(fake.seq).padStart(6, "0")}-ABCDEF${fake.seq}`;
        return { id: 9000 + fake.seq, code, plan, codePrefix: code.slice(0, 14), feeAmountMinor: 10 };
      });
    },
    async deleteCdkAndRefund(id: number) {
      const mode = fake.deleteFails;
      fake.deleteFails = "";
      if (mode === "error") throw new CardplatformError({ message: "upstream exploded", httpStatus: 500 });
      if (mode === "missing") throw new CardplatformError({ message: "not found", httpStatus: 404 });
      fake.deleted.push(id);
      const hook = fake.afterDelete;
      fake.afterDelete = null;
      if (hook) await hook();
    },
  };
  return {
    ...original,
    getDefaultCardplatformAccount: async () => account(),
    getCardplatformClientById: async () => ({ account: account(), client }),
  };
});

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  draw: typeof import("./agent-draw");
  config: typeof import("./config");
  orm: typeof import("drizzle-orm");
};
let m: Modules;
let agentId = 0;
let otherAgentId = 0;
let agentUser = { id: 0, role: "agent" as const };
let admin = { id: 0, role: "super_admin" as const };
let seq = 0;

async function drawItems(quantity = 1) {
  seq += 1;
  const result = await m.draw.createDrawOrder(agentId, { requestId: `req-${seq}`, planKey: "plus", quantity });
  const order = await m.db.query.agentDrawOrders.findFirst({
    where: m.orm.eq(m.schema.agentDrawOrders.drawNo, result.drawNo),
  });
  return m.db.query.agentDrawItems.findMany({
    where: m.orm.eq(m.schema.agentDrawItems.drawOrderId, order!.id),
  });
}

async function itemRow(id: number) {
  return m.db.query.agentDrawItems.findFirst({ where: m.orm.eq(m.schema.agentDrawItems.id, id) });
}

async function cdkRow(id: number) {
  return m.db.query.issuedCdks.findFirst({ where: m.orm.eq(m.schema.issuedCdks.id, id) });
}

beforeAll(async () => {
  m = {
    db: (await import("@/db")).db,
    schema: await import("@/db/schema"),
    draw: await import("./agent-draw"),
    config: await import("./config"),
    orm: await import("drizzle-orm"),
  };
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api");
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(m.schema as unknown as Record<string, unknown>),
  );
  const { client } = await import("@/db");
  for (const statement of statements) await client.execute(statement);
  await m.config.bootDb();

  const [agent, other] = await m.db
    .insert(m.schema.agents)
    .values([
      { displayName: "代理A", currentSlug: "agent-a" },
      { displayName: "代理B", currentSlug: "agent-b" },
    ])
    .returning();
  agentId = agent.id;
  otherAgentId = other.id;
  const [user, adminUser] = await m.db
    .insert(m.schema.users)
    .values([
      { username: "agent-a", passwordHash: "x", role: "agent", agentId },
      { username: "boss", passwordHash: "x", role: "super_admin" },
    ])
    .returning();
  agentUser = { id: user.id, role: "agent" };
  admin = { id: adminUser.id, role: "super_admin" };
  await m.db.insert(m.schema.agentDrawAccess).values({
    agentId,
    status: "approved",
    creditLimitCents: 10_000_000,
    maxPerDraw: 10,
  });
  const [plan] = await m.db
    .insert(m.schema.platformPlans)
    .values({
      planKey: "plus",
      basePlanKey: "plus",
      upstreamPlanKey: "plus",
      product: "gpt",
      name: "ChatGPT Plus",
      enabled: true,
      cardplatformSellable: true,
      globalCostPriceCents: 5000,
    })
    .returning();
  await m.db.insert(m.schema.agentPlanPrices).values({ agentId, planId: plan.id, enabled: true });
});

beforeEach(() => {
  fake.deleted = [];
  fake.deleteFails = "";
  fake.afterDelete = null;
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

describe("agentVoidDrawItem", () => {
  it("作废未使用的卡：卡台删卡，记作废、卡密停用，不再计费", async () => {
    const [item] = await drawItems();
    const cdk = await cdkRow(item.issuedCdkId);
    const result = await m.draw.agentVoidDrawItem({ itemId: item.id, reason: "买家退款" }, agentUser, agentId);
    expect(result).toEqual({ amountCents: item.amountCents });
    expect(fake.deleted).toEqual([Number(cdk!.upstreamRef)]);
    expect(await itemRow(item.id)).toMatchObject({ status: "void", voidReason: "买家退款", voidedBy: agentUser.id });
    expect((await cdkRow(item.issuedCdkId))?.status).toBe("disabled");
    const list = await m.draw.listAgentUnsettledItems(agentId);
    expect(list.items.some((row) => row.id === item.id)).toBe(false);
  });

  it("没填原因、别人的卡、已使用、已结算都不行，卡台不动", async () => {
    const [item] = await drawItems();
    await expect(m.draw.agentVoidDrawItem({ itemId: item.id, reason: "  " }, agentUser, agentId)).rejects.toThrow(
      "请填写作废原因",
    );
    await expect(m.draw.agentVoidDrawItem({ itemId: item.id, reason: "x" }, agentUser, otherAgentId)).rejects.toThrow(
      "卡密不存在",
    );

    await m.db.update(m.schema.issuedCdks).set({ status: "used" }).where(m.orm.eq(m.schema.issuedCdks.id, item.issuedCdkId));
    await expect(m.draw.agentVoidDrawItem({ itemId: item.id, reason: "x" }, agentUser, agentId)).rejects.toThrow(
      "只有未使用的卡密可以作废",
    );

    const [settled] = await drawItems();
    await m.db.update(m.schema.agentDrawItems).set({ status: "settled" }).where(m.orm.eq(m.schema.agentDrawItems.id, settled.id));
    await expect(m.draw.agentVoidDrawItem({ itemId: settled.id, reason: "x" }, agentUser, agentId)).rejects.toThrow(
      "已经结算",
    );
    expect(fake.deleted).toEqual([]);
  });

  it("卡台删卡失败：只回一句作废失败，不提卡台，本地账不动", async () => {
    const [item] = await drawItems();
    fake.deleteFails = "error";
    const error = await m.draw
      .agentVoidDrawItem({ itemId: item.id, reason: "重复提卡" }, agentUser, agentId)
      .catch((reason: Error) => reason);
    expect((error as Error).message).toBe("作废失败，请稍后再试或联系平台");
    expect((error as Error).message).not.toContain("卡台");
    expect((await itemRow(item.id))?.status).toBe("unsettled");
    expect((await cdkRow(item.issuedCdkId))?.status).toBe("unused");
  });

  it("卡台删了卡、本地没记上作废：告诉代理联系平台，留审计给管理员补账", async () => {
    const [item] = await drawItems();
    fake.afterDelete = async () => {
      await m.db
        .update(m.schema.agentDrawItems)
        .set({ status: "settled" })
        .where(m.orm.eq(m.schema.agentDrawItems.id, item.id));
    };
    await expect(m.draw.agentVoidDrawItem({ itemId: item.id, reason: "x" }, agentUser, agentId)).rejects.toThrow(
      "作废没有完成，请联系平台处理",
    );
    expect(fake.deleted).toHaveLength(1);
    const audit = await m.db.query.auditLogs.findFirst({
      where: m.orm.and(
        m.orm.eq(m.schema.auditLogs.action, "draw.item.void_orphaned"),
        m.orm.eq(m.schema.auditLogs.targetId, String(item.id)),
      ),
    });
    expect(audit).toBeTruthy();
  });

  it("卡台说卡已经不存在，也按作废成功", async () => {
    const [item] = await drawItems();
    fake.deleteFails = "missing";
    await m.draw.agentVoidDrawItem({ itemId: item.id, reason: "x" }, agentUser, agentId);
    expect((await itemRow(item.id))?.status).toBe("void");
  });

  it("每个代理每天最多自己作废 20 张；管理员替他作废的不算", async () => {
    const items = await drawItems(3);
    const used = await m.draw.agentVoidsToday(agentId);
    // 管理员作废一张，不占代理的额度
    await m.draw.voidDrawItem({ itemId: items[0].id, mode: "upstream", reason: "平台处理" }, admin);
    expect(await m.draw.agentVoidsToday(agentId)).toBe(used);

    // 补到 20 张：直接把几张账本行记成今天代理作废的
    // 一次最多提 10 张，分几次提
    const filler = [];
    for (let left = m.draw.AGENT_DAILY_VOID_LIMIT - used; left > 0; left -= 10) {
      filler.push(...(await drawItems(Math.min(10, left))));
    }
    const now = new Date().toISOString();
    for (const row of filler) {
      await m.db
        .update(m.schema.agentDrawItems)
        .set({ status: "void", voidedAt: now, voidedBy: agentUser.id, voidReason: "x" })
        .where(m.orm.eq(m.schema.agentDrawItems.id, row.id));
    }
    expect(await m.draw.agentVoidsToday(agentId)).toBe(m.draw.AGENT_DAILY_VOID_LIMIT);
    await expect(m.draw.agentVoidDrawItem({ itemId: items[1].id, reason: "x" }, agentUser, agentId)).rejects.toThrow(
      "每日上限",
    );
    const list = await m.draw.listAgentUnsettledItems(agentId);
    expect(list.voidQuota).toEqual({ used: 20, limit: 20 });
  });

  it("未结算列表标出哪张能作废", async () => {
    const [unused, used] = await drawItems(2);
    await m.db.update(m.schema.issuedCdks).set({ status: "used" }).where(m.orm.eq(m.schema.issuedCdks.id, used.issuedCdkId));
    const list = await m.draw.listAgentUnsettledItems(agentId, { pageSize: 100 });
    const byId = new Map(list.items.map((row) => [row.id, row.voidable]));
    expect(byId.get(unused.id)).toBe(true);
    expect(byId.get(used.id)).toBe(false);
  });
});
