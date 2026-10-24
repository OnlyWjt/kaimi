import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库走一遍 X / Grok 提卡：发给卡台的 plan 和地区、落库的套餐键和地区、重试按下单快照。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: dir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = joinPath(dir(), "kaimi-draw-products-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

type IssueCall = { plan: string; count: number; key: string; country?: string };
const fake = vi.hoisted(() => ({
  calls: [] as IssueCall[],
  protocol: "spacexcard-legacy",
  failNext: false,
  seq: 0,
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
  const account = () => ({ id: 1, protocol: fake.protocol, enabled: true, siteBase: "https://card.test" });
  const client = {
    async issueMany(plan: string, count: number, key: string, pref?: { paymentCountry?: string }) {
      fake.calls.push({ plan, count, key, country: pref?.paymentCountry });
      if (fake.failNext) {
        fake.failNext = false;
        throw new CardplatformError({ message: "卡台超时", outcomeUnknown: true });
      }
      return Array.from({ length: count }, () => {
        fake.seq += 1;
        const code = `ZC-TEST${String(fake.seq).padStart(6, "0")}-ABCDEF${fake.seq}`;
        return { id: 9000 + fake.seq, code, plan, codePrefix: code.slice(0, 14), feeAmountMinor: 10 };
      });
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
let seq = 0;

async function seedPlan(values: {
  planKey: string;
  product: string;
  upstreamPlanKey: string;
  paymentCountry: string;
  regionCapable: boolean;
  name: string;
}) {
  const [plan] = await m.db
    .insert(m.schema.platformPlans)
    .values({
      ...values,
      basePlanKey: values.planKey.split(":")[0],
      enabled: true,
      cardplatformSellable: true,
      globalCostPriceCents: 5000,
    })
    .returning();
  await m.db.insert(m.schema.agentPlanPrices).values({ agentId, planId: plan.id, enabled: true });
  return plan;
}

async function draw(planKey: string, quantity = 1) {
  seq += 1;
  return m.draw.createDrawOrder(agentId, { requestId: `req-${seq}`, planKey, quantity });
}

async function issuedFor(drawNo: string) {
  const order = await m.db.query.agentDrawOrders.findFirst({
    where: m.orm.eq(m.schema.agentDrawOrders.drawNo, drawNo),
  });
  const rows = await m.db.query.issuedCdks.findMany({
    where: m.orm.eq(m.schema.issuedCdks.drawOrderId, order!.id),
  });
  return { order: order!, rows };
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

  const [agent] = await m.db
    .insert(m.schema.agents)
    .values({ displayName: "代理X", currentSlug: "agent-x" })
    .returning();
  agentId = agent.id;
  await m.db.insert(m.schema.agentDrawAccess).values({
    agentId,
    status: "approved",
    creditLimitCents: 10_000_000,
    maxPerDraw: 10,
  });
  await seedPlan({ planKey: "plus", product: "gpt", upstreamPlanKey: "plus", paymentCountry: "", regionCapable: true, name: "ChatGPT Plus" });
  await seedPlan({ planKey: "x_premium_monthly", product: "x", upstreamPlanKey: "premium_monthly", paymentCountry: "JP", regionCapable: true, name: "X Premium 月付" });
  await seedPlan({ planKey: "x_premium_monthly:us", product: "x", upstreamPlanKey: "premium_monthly", paymentCountry: "US", regionCapable: true, name: "X Premium 月付" });
  await seedPlan({ planKey: "grok_premium_monthly", product: "grok", upstreamPlanKey: "grok_premium_monthly", paymentCountry: "US", regionCapable: false, name: "Grok Premium 月付" });
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
});

describe("X / Grok 自助提卡", () => {
  it("可提列表按产品线排：ChatGPT → X → Grok，名字带地区", async () => {
    const state = await m.draw.getAgentDrawState(agentId);
    expect(state.plans?.map((plan) => [plan.planKey, plan.name, plan.product])).toEqual([
      ["plus", "ChatGPT Plus · 菲区", "gpt"],
      ["x_premium_monthly", "X Premium 月付 · 日区", "x"],
      ["x_premium_monthly:us", "X Premium 月付 · 美区", "x"],
      ["grok_premium_monthly", "Grok Premium 月付", "grok"],
    ]);
  });

  it("X 日区：卡台收到裸键 + JP，库里记本站键 + JP", async () => {
    fake.calls = [];
    const order = await draw("x_premium_monthly", 2);
    expect(fake.calls).toEqual([expect.objectContaining({ plan: "premium_monthly", count: 2, country: "JP" })]);
    const { order: row, rows } = await issuedFor(order.drawNo);
    expect(row).toMatchObject({ status: "delivered", productSnapshot: "x", upstreamPlanKeySnapshot: "premium_monthly", paymentCountrySnapshot: "JP" });
    expect(rows.map((item) => [item.planKey, item.paymentCountry])).toEqual([
      ["x_premium_monthly", "JP"],
      ["x_premium_monthly", "JP"],
    ]);
  });

  it("X 美区变体：裸键 + US", async () => {
    fake.calls = [];
    const order = await draw("x_premium_monthly:us");
    expect(fake.calls[0]).toMatchObject({ plan: "premium_monthly", country: "US" });
    const { rows } = await issuedFor(order.drawNo);
    expect(rows[0]).toMatchObject({ planKey: "x_premium_monthly:us", paymentCountry: "US" });
  });

  it("Grok：带 grok_ 前缀 + US，虽然没有地区版也照样能提", async () => {
    fake.calls = [];
    const order = await draw("grok_premium_monthly");
    expect(fake.calls[0]).toMatchObject({ plan: "grok_premium_monthly", country: "US" });
    const { rows } = await issuedFor(order.drawNo);
    expect(rows[0]).toMatchObject({ planKey: "grok_premium_monthly", paymentCountry: "US" });
  });

  it("结果未知后重试：套餐行地区被改了，仍按下单快照的地区和同一个幂等键出卡", async () => {
    fake.calls = [];
    fake.failNext = true;
    seq += 1;
    const requestId = `req-${seq}`;
    const first = await m.draw.createDrawOrder(agentId, { requestId, planKey: "x_premium_monthly", quantity: 1 });
    expect(first.status).toBe("unknown");
    // 模拟同步把主行地区改掉
    await m.db
      .update(m.schema.platformPlans)
      .set({ paymentCountry: "PH", upstreamPlanKey: "x_premium_monthly" })
      .where(m.orm.eq(m.schema.platformPlans.planKey, "x_premium_monthly"));
    await m.db
      .update(m.schema.agentDrawOrders)
      .set({ updatedAt: "2000-01-01T00:00:00.000Z" })
      .where(m.orm.eq(m.schema.agentDrawOrders.drawNo, first.drawNo));
    const retried = await m.draw.createDrawOrder(agentId, { requestId, planKey: "x_premium_monthly", quantity: 1 });
    expect(retried.status).toBe("delivered");
    expect(fake.calls.map((call) => [call.plan, call.country])).toEqual([
      ["premium_monthly", "JP"],
      ["premium_monthly", "JP"],
    ]);
    expect(fake.calls[0].key).toBe(fake.calls[1].key);
    await m.db
      .update(m.schema.platformPlans)
      .set({ paymentCountry: "JP", upstreamPlanKey: "premium_monthly" })
      .where(m.orm.eq(m.schema.platformPlans.planKey, "x_premium_monthly"));
  });

  it("卡台不支持付款地区：X / Grok 提不了，提示不再叫人去提菲区", async () => {
    fake.protocol = "avanfinity-2026-08";
    await expect(draw("grok_premium_monthly")).rejects.toThrow("当前卡台不支持 Grok 发卡");
    await expect(draw("x_premium_monthly")).rejects.toThrow("当前卡台不支持 X 订阅码 发卡");
    fake.protocol = "spacexcard-legacy";
  });
});
