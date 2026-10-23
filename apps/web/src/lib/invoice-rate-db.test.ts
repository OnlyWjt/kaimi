import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库：新列能迁移、默认值是老规则；自定义税点单从下单快照 → 收益行 → 结算验算一路对得上。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = join(tmpdir(), "kaimi-invoice-rate-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));

type Modules = {
  db: typeof import("@/db").db;
  client: typeof import("@/db").client;
  orm: typeof import("drizzle-orm");
  schema: typeof import("@/db/schema");
  migrateLib: typeof import("@/db/migrate-lib");
  policy: typeof import("./invoice-policy");
  invoice: typeof import("./invoice-core");
  ledger: typeof import("./order-ledger-core");
  stats: typeof import("./earnings-stats-core");
};
let m: Modules;

beforeAll(async () => {
  const dbModule = await import("@/db");
  m = {
    db: dbModule.db,
    client: dbModule.client,
    orm: await import("drizzle-orm"),
    schema: await import("@/db/schema"),
    migrateLib: await import("@/db/migrate-lib"),
    policy: await import("./invoice-policy"),
    invoice: await import("./invoice-core"),
    ledger: await import("./order-ledger-core"),
    stats: await import("./earnings-stats-core"),
  };
  await m.migrateLib.ensureSchema();
  // 再跑一次：重复列要被忽略，不能让启动失败。
  await m.migrateLib.ensureSchema();
});

afterAll(async () => {
  m?.client.close();
  const { rmSync } = await import("node:fs");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行开头会删 */
    }
  }
});

let orderSeq = 0;
async function insertOrder(agentId: number, goodsCents: number, invoicePolicy?: import("./invoice-core").InvoicePolicy) {
  const { schema, invoice, ledger, db } = m;
  const feeRule = { ratePpm: 6000, fixedFeeCents: 0 };
  const quote = invoice.quoteStorePayment({
    goodsCents,
    costTotalCents: 10000,
    invoiceRequested: true,
    feeRule,
    invoicePolicy,
  });
  const snapshot = quote.snapshot;
  const computed = ledger.computeOrderLedger({
    grossCents: quote.payCents,
    invoiceSurchargeCents: snapshot.invoiceSurchargeCents,
    invoiceSplit: snapshot.invoiceSplit,
    invoiceAgentShareCents: snapshot.invoiceAgentShareCents,
    invoiceAgentTaxCents: snapshot.invoiceAgentTaxCents,
    agentCostTotalCents: 10000,
    upstreamCostTotalCents: 8000,
    feeRule,
  });
  orderSeq += 1;
  const [row] = await db
    .insert(schema.storeOrders)
    .values({
      orderNo: `KS-TEST-${orderSeq}`,
      queryTokenHash: `hash-${orderSeq}`,
      queryTokenEncrypted: "",
      agentId,
      planId: 1,
      planKeySnapshot: "plan",
      productNameSnapshot: "测试套餐",
      retailPriceCents: goodsCents,
      agentCostCents: 10000,
      grossCents: quote.payCents,
      agentCostTotalCents: 10000,
      paymentChannel: "alipay",
      feeRatePpm: feeRule.ratePpm,
      fixedFeeCents: feeRule.fixedFeeCents,
      estimatedPaymentFeeCents: computed.finalPaymentFeeCents,
      finalPaymentFeeCents: computed.finalPaymentFeeCents,
      agentEarningCents: computed.agentEarningCents,
      agentFeeCents: computed.agentFeeCents,
      platformFeeCents: computed.platformFeeCents,
      upstreamCostTotalCents: 8000,
      platformProfitCents: computed.platformProfitCents,
      invoiceRequested: true,
      invoiceAmountCents: quote.payCents,
      ...snapshot,
      fulfillmentIdempotencyKey: `key-${orderSeq}`,
      payStatus: "paid",
      fulfillStatus: "delivered",
    })
    .returning();
  return row!;
}

async function insertEarning(order: Awaited<ReturnType<typeof insertOrder>>) {
  const [row] = await m.db
    .insert(m.schema.agentEarnings)
    .values({
      orderId: order.id,
      agentId: order.agentId,
      ...m.ledger.earningSnapshotFromOrder(order),
      status: "pending",
      confirmedAt: "2026-10-23T00:00:00.000Z",
    })
    .returning();
  return row!;
}

describe("代理自定义开票税点（真库）", () => {
  let agentId = 0;

  it("新代理默认没开通、税点 10%，扣税比例默认 1%", async () => {
    const [agent] = await m.db
      .insert(m.schema.agents)
      .values({ displayName: "测试代理", currentSlug: "invoice-rate-test" })
      .returning();
    agentId = agent!.id;
    expect(agent!.invoiceRateCustomEnabled).toBe(false);
    expect(agent!.invoiceRatePct).toBe(10);
    expect(await m.policy.getAgentInvoiceTaxBp()).toBe(100);
    expect(await m.policy.loadAgentInvoicePolicy(agentId)).toEqual(m.invoice.LEGACY_INVOICE_POLICY);
  });

  it("老规则开票单：快照 split=false，收益行开票分成 0，验算通过", async () => {
    const order = await insertOrder(agentId, 20000, await m.policy.loadAgentInvoicePolicy(agentId));
    expect(order.invoiceSplit).toBe(false);
    expect(order.invoiceSurchargeCents).toBe(2000);
    expect(order.invoiceRatePct).toBe(10);
    expect(order.invoiceAgentShareCents).toBe(0);
    const earning = await insertEarning(order);
    expect(earning.invoiceShareCents).toBe(0);
    expect(earning.earningCents).toBe(20000 - 10000 - 120);
    expect(m.ledger.verifyLedger(order, earning)).toEqual([]);
  });

  it("开通 17%：快照落库后再读出来，收益、平台毛利、验算全对", async () => {
    await m.db
      .update(m.schema.agents)
      .set({ invoiceRateCustomEnabled: true, invoiceRatePct: 17 })
      .where(m.orm.eq(m.schema.agents.id, agentId));
    const policy = await m.policy.loadAgentInvoicePolicy(agentId);
    expect(policy).toEqual({ split: true, ratePct: 17, agentTaxBp: 100 });

    const order = await insertOrder(agentId, 20000, policy);
    const fresh = (await m.db.query.storeOrders.findFirst({
      where: m.orm.eq(m.schema.storeOrders.id, order.id),
    }))!;
    expect(fresh.invoiceSplit).toBe(true);
    expect(fresh.grossCents).toBe(23400);
    expect(fresh.invoiceSurchargeCents).toBe(3400);
    expect(fresh.invoiceAgentShareCents).toBe(2200);
    expect(fresh.invoiceAgentTaxCents).toBe(22);
    expect(fresh.invoiceAgentTaxBp).toBe(100);
    expect(fresh.invoiceRatePct).toBe(17);
    expect(fresh.agentFeeCents).toBe(140);
    expect(fresh.platformFeeCents).toBe(0);
    expect(fresh.agentEarningCents).toBe(20000 + 2178 - 10000 - 140);
    expect(fresh.platformProfitCents).toBe(10000 + 1200 + 22 - 8000);

    const earning = await insertEarning(fresh);
    expect(earning.grossCents).toBe(20000);
    expect(earning.invoiceShareCents).toBe(2178);
    expect(m.ledger.verifyLedger(fresh, earning)).toEqual([]);
    expect(m.ledger.recomputeStoredLedger(fresh).agentEarningCents).toBe(fresh.agentEarningCents);

    // 平台开票收入 = 6% + 扣下的税；平台毛利恒等式照旧成立
    const stats = m.stats.buildEarningsStats({
      grain: "day",
      earnings: [
        {
          agentId,
          agentName: "测试代理",
          confirmedAt: earning.confirmedAt,
          grossCents: earning.grossCents,
          costCents: earning.costCents,
          paymentFeeCents: earning.paymentFeeCents,
          totalFeeCents: earning.totalFeeCents,
          upstreamCents: fresh.upstreamCostTotalCents,
          platformFeeCents: fresh.platformFeeCents,
          platformProfitCents: fresh.platformProfitCents,
          invoiceSurchargeCents: fresh.invoiceSurchargeCents,
          invoiceShareCents: earning.invoiceShareCents,
          payStatus: "paid",
          upstreamCostSource: "plan",
          earningCents: earning.earningCents,
          status: earning.status,
        },
      ],
      adjustments: [],
    });
    expect(stats.totals.invoiceCents).toBe(1200 + 22);
    expect(stats.totals.profitCents).toBe(
      stats.totals.basisCostCents +
        stats.totals.basisInvoiceCents -
        stats.totals.basisUpstreamCents -
        stats.totals.basisPlatformFeeCents,
    );
  });

  it("关掉开关后代理存的 17% 不再生效，已下的单快照不变", async () => {
    await m.db
      .update(m.schema.agents)
      .set({ invoiceRateCustomEnabled: false })
      .where(m.orm.eq(m.schema.agents.id, agentId));
    expect(await m.policy.loadAgentInvoicePolicy(agentId)).toEqual(m.invoice.LEGACY_INVOICE_POLICY);
    const old = await m.db.query.storeOrders.findFirst({
      where: m.orm.eq(m.schema.storeOrders.invoiceRatePct, 17),
    });
    expect(old?.invoiceSplit).toBe(true);
    expect(old?.invoiceAgentShareCents).toBe(2200);
  });

  it("后台改了扣税比例只影响之后的单", async () => {
    await m.db
      .insert(m.schema.settings)
      .values({ key: m.invoice.INVOICE_AGENT_TAX_SETTING, value: "300" })
      .onConflictDoUpdate({ target: m.schema.settings.key, set: { value: "300" } });
    await m.db
      .update(m.schema.agents)
      .set({ invoiceRateCustomEnabled: true })
      .where(m.orm.eq(m.schema.agents.id, agentId));
    const policy = await m.policy.loadAgentInvoicePolicy(agentId);
    expect(policy.agentTaxBp).toBe(300);
    const order = await insertOrder(agentId, 20000, policy);
    expect(order.invoiceAgentTaxCents).toBe(66);
    expect(order.invoiceAgentTaxBp).toBe(300);
  });
});
