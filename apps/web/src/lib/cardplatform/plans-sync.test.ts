import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库走一遍按产品同步：三条线各建各的行，一条线拉失败不影响其他线。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: dir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = joinPath(dir(), "kaimi-plans-sync-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

type Catalogs = Partial<Record<"gpt" | "x" | "grok", unknown>>;
const fake = vi.hoisted(() => ({
  catalogs: {} as Catalogs,
  failing: new Set<string>(),
  account: { id: 0, siteBase: "https://card.test", enabled: true } as Record<string, unknown>,
}));

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));
vi.mock("@/lib/cardplatform/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config")>();
  const { parsePlansCatalog } = await import("./client");
  return {
    ...original,
    getDefaultCardplatformClient: async () => ({
      account: fake.account,
      client: {
        async getPlansWithRegions(_timeout: number, product: "gpt" | "x" | "grok") {
          if (fake.failing.has(product)) throw new Error("卡台超时");
          return parsePlansCatalog(fake.catalogs[product] ?? {}, product);
        },
      },
    }),
  };
});

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  plans: typeof import("./plans");
  config: typeof import("@/lib/config");
  orm: typeof import("drizzle-orm");
};
let m: Modules;

async function row(planKey: string) {
  return m.db.query.platformPlans.findFirst({
    where: m.orm.eq(m.schema.platformPlans.planKey, planKey),
  });
}

beforeAll(async () => {
  m = {
    db: (await import("@/db")).db,
    schema: await import("@/db/schema"),
    plans: await import("./plans"),
    config: await import("@/lib/config"),
    orm: await import("drizzle-orm"),
  };
  // 和 agent-draw-finished.test 一样：先按 Drizzle schema 建全表，再跑 bootDb。
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api");
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(m.schema as unknown as Record<string, unknown>),
  );
  const { client } = await import("@/db");
  for (const statement of statements) await client.execute(statement);
  await m.config.bootDb();

  fake.catalogs = {
    gpt: {
      plans: { plus: { enabled: true }, x_premium_monthly: { enabled: true } },
      registry: [{ key: "plus", label: "Plus", sort_order: 1 }],
      payment_regions: [{ country: "US", currency: "USD" }],
    },
    x: {
      plans: { x_premium_monthly: { enabled: true }, x_basic_monthly: { enabled: true } },
      registry: [
        { key: "basic_monthly", label: "X Basic 月付", sort_order: 1 },
        { key: "premium_monthly", label: "X Premium 月付", sort_order: 2 },
      ],
      payment_regions: [
        { country: "JP", currency: "JPY" },
        { country: "US", currency: "USD" },
      ],
    },
    grok: {
      plans: { grok_premium_monthly: { enabled: true } },
      registry: [{ key: "premium_monthly", label: "Grok Premium 月付", sort_order: 1 }],
    },
  };
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

describe("syncDefaultCardplatformPlans 按产品同步", () => {
  it("老库里被当成 GPT 存下来的 x_* 行会被改对", async () => {
    // 模拟以前只拉 GPT 目录时混进来的行：上游键带前缀、没有地区。
    await m.db.insert(m.schema.platformPlans).values({
      planKey: "x_premium_monthly",
      basePlanKey: "x_premium_monthly",
      upstreamPlanKey: "x_premium_monthly",
      product: "x",
      name: "x_premium_monthly",
      cardplatformSellable: true,
    });

    const result = await m.plans.syncDefaultCardplatformPlans();
    expect(result.products.map((item) => [item.product, item.count, item.error ?? ""])).toEqual([
      ["gpt", 1, ""],
      ["x", 2, ""],
      // Premium 月付 + 它的半价行
      ["grok", 2, ""],
    ]);

    const plus = await row("plus");
    expect(plus).toMatchObject({ product: "gpt", upstreamPlanKey: "plus", paymentCountry: "", category: "" });
    expect(await row("plus:us")).toMatchObject({ product: "gpt", paymentCountry: "US" });

    expect(await row("x_basic_monthly")).toMatchObject({
      product: "x",
      upstreamPlanKey: "basic_monthly",
      paymentCountry: "JP",
      regionCapable: true,
      category: "X 订阅码",
      enabled: false,
      cardplatformSellable: true,
    });
    // 默认白名单是 US,CL：X 只出美区变体，日区是主行不出变体。
    expect(await row("x_basic_monthly:us")).toMatchObject({
      product: "x",
      upstreamPlanKey: "basic_monthly",
      paymentCountry: "US",
    });
    expect(await row("x_basic_monthly:jp")).toBeUndefined();

    expect(await row("x_premium_monthly")).toMatchObject({
      product: "x",
      upstreamPlanKey: "premium_monthly",
      paymentCountry: "JP",
      category: "X 订阅码",
    });

    expect(await row("grok_premium_monthly")).toMatchObject({
      product: "grok",
      upstreamPlanKey: "grok_premium_monthly",
      paymentCountry: "US",
      regionCapable: false,
      category: "Grok",
      cardplatformSellable: true,
    });
    expect(await row("grok_premium_monthly:us")).toBeUndefined();
  });

  it("X 拉失败时只报错，GPT 和 Grok 照常，X 原有的行也不被下架", async () => {
    fake.failing = new Set(["x"]);
    const result = await m.plans.syncDefaultCardplatformPlans();
    fake.failing = new Set();
    expect(result.products.find((item) => item.product === "x")?.error).toBe("卡台超时");
    expect((await row("plus"))?.cardplatformSellable).toBe(true);
    expect((await row("x_basic_monthly"))?.cardplatformSellable).toBe(true);
    expect((await row("grok_premium_monthly"))?.cardplatformSellable).toBe(true);
  });

  it("一条线的档位下架，只复位这条线", async () => {
    const grok = fake.catalogs.grok;
    fake.catalogs.grok = { plans: {}, registry: [] };
    await m.plans.syncDefaultCardplatformPlans();
    fake.catalogs.grok = grok;
    expect((await row("grok_premium_monthly"))?.cardplatformSellable).toBe(false);
    expect((await row("x_basic_monthly"))?.cardplatformSellable).toBe(true);
    expect((await row("plus"))?.cardplatformSellable).toBe(true);
  });

  it("Grok 月付 Premium / Super / Ultra 生成半价档位：发码用正价键、默认停用、可售跟正价行", async () => {
    const grok = fake.catalogs.grok;
    fake.catalogs.grok = {
      plans: {
        grok_plus_monthly: { enabled: true },
        grok_premium_monthly: { enabled: true },
        grok_super_monthly: { enabled: false },
        grok_super_yearly: { enabled: true },
      },
      registry: [
        { key: "plus_monthly", label: "Plus 月付", sort_order: 1 },
        { key: "premium_monthly", label: "Grok Premium 月付", sort_order: 2 },
        { key: "super_monthly", label: "Grok Super 月付", sort_order: 3 },
        { key: "super_yearly", label: "Grok Super 年付", sort_order: 4 },
      ],
    };
    const result = await m.plans.syncDefaultCardplatformPlans();
    // plus / premium / premium 半价 / super 年付；卡台停用的 super 月付不算
    expect(result.products.find((item) => item.product === "grok")?.count).toBe(4);

    expect(await row("grok_premium_monthly_half")).toMatchObject({
      product: "grok",
      basePlanKey: "grok_premium_monthly_half",
      upstreamPlanKey: "grok_premium_monthly",
      paymentCountry: "US",
      category: "Grok",
      name: "Grok Premium 月付（首月半价）",
      sortOrder: 2,
      enabled: false,
      cardplatformSellable: true,
      globalCostPriceCents: 0,
    });
    // 卡台停用的正价档不出现在目录里，半价行也不会生成；年付和 Plus 没有半价
    expect(await row("grok_super_monthly_half")).toBeUndefined();
    expect(await row("grok_super_yearly_half")).toBeUndefined();
    expect(await row("grok_plus_monthly_half")).toBeUndefined();

    // 管理员开启并改了名、定了价，再同步不覆盖
    await m.db
      .update(m.schema.platformPlans)
      .set({ enabled: true, name: "Premium 首月半价", globalCostPriceCents: 900 })
      .where(m.orm.eq(m.schema.platformPlans.planKey, "grok_premium_monthly_half"));
    await m.plans.syncDefaultCardplatformPlans();
    expect(await row("grok_premium_monthly_half")).toMatchObject({
      enabled: true,
      name: "Premium 首月半价",
      globalCostPriceCents: 900,
      cardplatformSellable: true,
    });

    // 正价下架，半价跟着下架
    fake.catalogs.grok = {
      plans: { grok_plus_monthly: { enabled: true } },
      registry: [{ key: "plus_monthly", label: "Plus 月付", sort_order: 1 }],
    };
    await m.plans.syncDefaultCardplatformPlans();
    expect((await row("grok_premium_monthly"))?.cardplatformSellable).toBe(false);
    expect((await row("grok_premium_monthly_half"))?.cardplatformSellable).toBe(false);
    fake.catalogs.grok = grok;
  });

  it("全部失败才抛错", async () => {
    fake.failing = new Set(["gpt", "x", "grok"]);
    await expect(m.plans.syncDefaultCardplatformPlans()).rejects.toThrow(/ChatGPT：卡台超时/);
    fake.failing = new Set();
  });

  it("卡台不支持付款地区时跳过 X / Grok 并停售", async () => {
    // 环境变量账户（id 0）一律按旧台算；库里的账户按协议判断，Avanfinity 不支持地区。
    fake.account = { id: 99, siteBase: "https://card.test", enabled: true, protocol: "avanfinity-2026-08" };
    const result = await m.plans.syncDefaultCardplatformPlans();
    fake.account = { id: 0, siteBase: "https://card.test", enabled: true };
    expect(result.products.find((item) => item.product === "x")?.skipped).toBeTruthy();
    expect(result.products.find((item) => item.product === "grok")?.skipped).toBeTruthy();
    expect((await row("x_basic_monthly"))?.cardplatformSellable).toBe(false);
    expect((await row("grok_premium_monthly"))?.cardplatformSellable).toBe(false);
    expect((await row("plus"))?.cardplatformSellable).toBe(true);
  });
});
