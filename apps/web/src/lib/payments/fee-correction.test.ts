import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { computeOrderLedger, ledgerInputFromOrder, recomputeStoredLedger } from "../order-ledger-core";

// reconciliation.ts 用 @/ 别名，vitest 不解析：把用到的别名指到相对路径，数据库换成内存库。
vi.mock("@/db", async () => ({ db: {} }));
vi.mock("@/db/schema", async () => await import("../../db/schema"));
vi.mock("@/lib/ids", async () => ({ newOrderNo: () => "test-order-no" }));
vi.mock("@/lib/order-ledger-core", async () => await import("../order-ledger-core"));
vi.mock("@/lib/reconciliation-core", async () => await import("../reconciliation-core"));

const { applyAuditCorrection, applySettledFeeReview } = await import("./fee-correction-db");
const { effectiveEarningCents, insertLegacyAdjustment, insertOrderAdjustment, ReconciliationError } =
  await import("../reconciliation");
const { AUDIT_FEE_REVIEW_PENDING_MESSAGE } = await import("./fee-lock-core");

const { agentEarningAdjustments, agentEarnings, agents, storeOrders } = schema;

// 实付 10000，成本 7000，费率 0.6%：估算手续费 60 → 收益 2940；网关手续费 90 → 收益 2910。
const BASE = {
  grossCents: 10000,
  invoiceSurchargeCents: 0,
  agentCostTotalCents: 7000,
  upstreamCostTotalCents: 6000,
  feeRatePpm: 6000,
  fixedFeeCents: 0,
};
const estimate = computeOrderLedger(ledgerInputFromOrder(BASE));
const gateway = computeOrderLedger(ledgerInputFromOrder(BASE), { gatewayFeeCents: 90 });
const NOW = "2026-10-10T00:00:00.000Z";

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function createTables() {
  const api = await import("drizzle-kit/api");
  const prev = await api.generateSQLiteDrizzleJson({});
  const cur = await api.generateSQLiteDrizzleJson(schema);
  for (const statement of await api.generateSQLiteMigration(prev, cur)) {
    await client.execute(statement);
  }
}

async function seedOrder(options: {
  feeStatus: string;
  /** 订单金额字段所处口径：estimate = 下单估算；gateway = 已按网关值定稿。 */
  amounts?: "estimate" | "gateway";
  earningStatus?: "settled" | "settling" | "pending";
}) {
  const ledger = options.amounts === "gateway" ? gateway : estimate;
  await db.insert(agents).values({ id: 1, displayName: "A", currentSlug: "a" });
  const [order] = await db
    .insert(storeOrders)
    .values({
      id: 1,
      orderNo: "KM-1",
      queryTokenHash: "h",
      agentId: 1,
      planId: 1,
      planKeySnapshot: "plus",
      productNameSnapshot: "Plus",
      retailPriceCents: 10000,
      agentCostCents: 7000,
      grossCents: BASE.grossCents,
      agentCostTotalCents: BASE.agentCostTotalCents,
      upstreamCostTotalCents: BASE.upstreamCostTotalCents,
      paymentChannel: "alipay",
      feeRatePpm: BASE.feeRatePpm,
      fixedFeeCents: BASE.fixedFeeCents,
      estimatedPaymentFeeCents: estimate.finalPaymentFeeCents,
      actualPaymentFeeCents: 90,
      finalPaymentFeeCents: ledger.finalPaymentFeeCents,
      agentFeeCents: ledger.agentFeeCents,
      platformFeeCents: ledger.platformFeeCents,
      agentEarningCents: ledger.agentEarningCents,
      platformProfitCents: ledger.platformProfitCents,
      feeReconcileStatus: options.feeStatus,
      payStatus: "paid",
      fulfillStatus: "delivered",
      fulfillmentIdempotencyKey: "k1",
      updatedAt: "2026-10-01T00:00:00.000Z",
    })
    .returning();
  // 收益行始终是已返佣时的估算口径，之后不再改。
  const [earning] = await db
    .insert(agentEarnings)
    .values({
      id: 1,
      orderId: 1,
      agentId: 1,
      grossCents: 10000,
      costCents: 7000,
      agentFeeCents: estimate.agentFeeCents,
      totalFeeCents: estimate.finalPaymentFeeCents,
      paymentFeeCents: estimate.agentFeeCents,
      earningCents: estimate.agentEarningCents,
      status: options.earningStatus ?? "settled",
      confirmedAt: "2026-09-30T00:00:00.000Z",
    })
    .returning();
  return { order: order!, earning: earning! };
}

async function orderRow() {
  return (await db.query.storeOrders.findFirst({ where: eq(storeOrders.id, 1) }))!;
}
async function adjustments() {
  return await db.select().from(agentEarningAdjustments);
}
function reviewInput(overrides: Partial<Parameters<typeof applySettledFeeReview>[1]> = {}) {
  return {
    orderId: 1,
    orderNo: "KM-1",
    earningId: 1,
    decision: "accept_gateway" as const,
    status: "confirmed" as const,
    note: "",
    now: NOW,
    estimatedFeeCents: estimate.finalPaymentFeeCents,
    gatewayFee: 90,
    ledger: gateway,
    ...overrides,
  };
}
async function audit() {
  const order = await orderRow();
  return await db.transaction((tx) =>
    applyAuditCorrection(tx, {
      orderId: 1,
      orderNo: "KM-1",
      earningId: 1,
      expectedUpdatedAt: order.updatedAt,
      now: "2026-10-11T00:00:00.000Z",
    }),
  );
}

/**
 * libsql 的 transaction() 会把当前连接交给事务、之后另开新连接，:memory: 库的数据因此丢失。
 * 这里让事务就在同一条连接上 BEGIN / COMMIT / ROLLBACK，既保住内存库，也能真实验证回滚。
 */
function singleConnection(real: Client): Client {
  return new Proxy(real, {
    get(target, prop) {
      if (prop !== "transaction") {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        await target.execute("BEGIN");
        let closed = false;
        return {
          execute: (stmt: Parameters<Client["execute"]>[0]) => target.execute(stmt),
          batch: (stmts: Parameters<Client["batch"]>[0]) => target.batch(stmts),
          executeMultiple: (sqlText: string) => target.executeMultiple(sqlText),
          commit: async () => {
            await target.execute("COMMIT");
            closed = true;
          },
          rollback: async () => {
            if (!closed) await target.execute("ROLLBACK");
            closed = true;
          },
          close: () => undefined,
          get closed() {
            return closed;
          },
        };
      };
    },
  }) as Client;
}

beforeEach(async () => {
  client = createClient({ url: "file::memory:" });
  await createTables();
  db = drizzle(singleConnection(client), { schema });
});
afterEach(() => client.close());

describe("A. fee-review settled 之后 audit 不能冲回更正", () => {
  it("recomputeStoredLedger 只看订单自己的字段（毛额、成本、费率、finalPaymentFeeCents），不看调整", () => {
    expect(recomputeStoredLedger({ ...BASE, finalPaymentFeeCents: 60 }).agentEarningCents).toBe(2940);
    expect(recomputeStoredLedger({ ...BASE, finalPaymentFeeCents: 90 }).agentEarningCents).toBe(2910);
  });

  it("复现旧行为：订单金额不改、只写 fee_correction，随后 audit 会写反向 +30 冲回", async () => {
    const { earning } = await seedOrder({ feeStatus: "confirmed", amounts: "estimate" });
    await db.transaction((tx) =>
      insertOrderAdjustment(tx, {
        agentId: 1,
        orderId: 1,
        sourceEarningId: earning.id,
        type: "fee_correction",
        amountCents: -30,
        reason: "旧实现",
        reference: "KM-1",
        businessEventKey: "fee-review:1:rec1",
        now: NOW,
      }),
    );
    const result = await audit();
    expect(result.deltaCents).toBe(30);
    expect((await adjustments()).map((row) => row.amountCents).sort()).toEqual([-30, 30]);
  });

  it("修复后：accept_gateway 同事务改订单金额 + 写 -30；随后 audit 为 0（unchanged），不再写调整", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    const result = await db.transaction((tx) => applySettledFeeReview(tx, reviewInput()));
    expect(result).toMatchObject({ deltaCents: -30, replayed: false });

    const order = await orderRow();
    expect(order.feeReconcileStatus).toBe("confirmed");
    expect(order.finalPaymentFeeCents).toBe(90);
    expect(order.agentFeeCents).toBe(gateway.agentFeeCents);
    expect(order.platformFeeCents).toBe(gateway.platformFeeCents);
    expect(order.agentEarningCents).toBe(2910);
    expect(order.platformProfitCents).toBe(gateway.platformProfitCents);
    // 已结算收益行不改。
    const earning = await db.query.agentEarnings.findFirst({ where: eq(agentEarnings.id, 1) });
    expect(earning).toMatchObject({ earningCents: 2940, agentFeeCents: estimate.agentFeeCents, status: "settled" });
    // L（订单）== E（收益行 + 有效调整）。
    expect(await effectiveEarningCents(db, 1, 2940)).toBe(recomputeStoredLedger(order).agentEarningCents);

    const again = await audit();
    expect(again).toEqual({ deltaCents: 0, replayed: false, adjustmentId: null });
    const rows = await adjustments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "fee_correction", amountCents: -30, status: "pending" });
    expect(rows[0]!.businessEventKey).toMatch(/^fee-review:1:/);
  });

  it("keep_estimate：不改订单金额、不写调整，只定稿状态；之后 audit 为 0", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    const result = await db.transaction((tx) =>
      applySettledFeeReview(
        tx,
        reviewInput({ decision: "keep_estimate", status: "unsupported", gatewayFee: 60, ledger: estimate, note: "保留" }),
      ),
    );
    expect(result.deltaCents).toBe(0);
    const order = await orderRow();
    expect(order).toMatchObject({
      feeReconcileStatus: "unsupported",
      feeReconcileLastError: "保留",
      finalPaymentFeeCents: 60,
      agentEarningCents: 2940,
      agentFeeCents: estimate.agentFeeCents,
      platformFeeCents: estimate.platformFeeCents,
    });
    expect(await adjustments()).toHaveLength(0);
    expect((await audit()).deltaCents).toBe(0);
  });

  it("重复提交同一审核：订单已不是 manual_review → 409，不会重复写调整", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    await db.transaction((tx) => applySettledFeeReview(tx, reviewInput()));
    await expect(db.transaction((tx) => applySettledFeeReview(tx, reviewInput()))).rejects.toMatchObject({
      code: "SNAPSHOT_CHANGED",
      status: 409,
    });
    expect(await adjustments()).toHaveLength(1);
  });

  it("订单已退款或不是 paid：条件更新不命中，整个事务不写任何东西", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    await db.update(storeOrders).set({ refundedAt: NOW }).where(eq(storeOrders.id, 1));
    await expect(db.transaction((tx) => applySettledFeeReview(tx, reviewInput()))).rejects.toBeInstanceOf(
      ReconciliationError,
    );
    expect(await adjustments()).toHaveLength(0);
    expect((await orderRow()).agentEarningCents).toBe(2940);
  });

  it("调整写入失败（有效收益下界）：事务回滚，订单仍是 manual_review 且金额未动", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    const tooLow = { ...gateway, agentEarningCents: -5000 };
    await expect(
      db.transaction((tx) => applySettledFeeReview(tx, reviewInput({ ledger: tooLow }))),
    ).rejects.toMatchObject({ code: "CORRECTION_EXCEEDS_EARNING", status: 422 });
    const order = await orderRow();
    expect(order.feeReconcileStatus).toBe("manual_review");
    expect(order.agentEarningCents).toBe(2940);
    expect(order.finalPaymentFeeCents).toBe(60);
    expect(await adjustments()).toHaveLength(0);
  });

  it("manual_review 订单 audit 返回 409，不写调整（订单金额还是旧值）", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    await expect(audit()).rejects.toMatchObject({
      code: "FEE_REVIEW_PENDING",
      status: 409,
      message: AUDIT_FEE_REVIEW_PENDING_MESSAGE,
    });
    expect(await adjustments()).toHaveLength(0);
  });

  it("settling 收益 + manual_review：fee-review 已结分支拒绝（路由层先判 settling 返回 409），审计事务体也不会对 settling 写更正", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate", earningStatus: "settling" });
    await expect(db.transaction((tx) => applySettledFeeReview(tx, reviewInput()))).rejects.toMatchObject({
      code: "SNAPSHOT_CHANGED",
    });
    expect(await adjustments()).toHaveLength(0);
    expect((await orderRow()).agentEarningCents).toBe(2940);
  });
});

describe("audit 事件键", () => {
  it("订单字段与 E 不一致时写入；同一状态重复提交 replayed，E 变化后得到新键", async () => {
    // 订单已按网关定稿(2910)，但收益行是估算 2940，且没有任何调整：audit 补 -30。
    await seedOrder({ feeStatus: "confirmed", amounts: "gateway" });
    const first = await audit();
    expect(first).toMatchObject({ deltaCents: -30, replayed: false });
    // 同一状态下再次提交：E 已变为 2910 → delta 0。
    expect((await audit()).deltaCents).toBe(0);
    // 撤销这条调整后回到原状态，再提交命中同一事件键 → replayed，不新增行。
    await db.update(agentEarningAdjustments).set({ status: "cancelled" });
    const replay = await audit();
    expect(replay).toMatchObject({ deltaCents: -30, replayed: true });
    expect(await adjustments()).toHaveLength(1);
  });
});

describe("C. 旧 legacy:fee_correction 历史行存在时不重复计入", () => {
  it("audit：legacy 行已把 E 调到与订单字段一致 → unchanged，不再写", async () => {
    // 旧 audit 实现的结果：订单字段 = 网关口径(2910)，收益行 2940，legacy 调整 -30。
    await seedOrder({ feeStatus: "confirmed", amounts: "gateway" });
    await db.transaction((tx) =>
      insertLegacyAdjustment(tx, {
        agentId: 1,
        orderId: 1,
        sourceEarningId: 1,
        type: "fee_correction",
        amountCents: -30,
        reason: "旧 audit",
        now: NOW,
      }),
    );
    expect((await adjustments())[0]!.businessEventKey).toBe("legacy:fee_correction:1");
    expect((await audit()).deltaCents).toBe(0);
    expect(await adjustments()).toHaveLength(1);
  });

  it("fee-review：legacy 已补 -30 且订单待核对 → 目标 2910 == E，不重复写", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    await db.transaction((tx) =>
      insertLegacyAdjustment(tx, {
        agentId: 1,
        orderId: 1,
        sourceEarningId: 1,
        type: "fee_correction",
        amountCents: -30,
        reason: "旧 audit",
        now: NOW,
      }),
    );
    const result = await db.transaction((tx) => applySettledFeeReview(tx, reviewInput()));
    expect(result.deltaCents).toBe(0);
    expect(await adjustments()).toHaveLength(1);
    expect((await orderRow()).agentEarningCents).toBe(2910);
    expect((await audit()).deltaCents).toBe(0);
  });

  it("fee-review：legacy 只补了 -10 → 只补剩余 -20，总有效调整 = -30", async () => {
    await seedOrder({ feeStatus: "manual_review", amounts: "estimate" });
    await db.transaction((tx) =>
      insertLegacyAdjustment(tx, {
        agentId: 1,
        orderId: 1,
        sourceEarningId: 1,
        type: "fee_correction",
        amountCents: -10,
        reason: "旧 audit",
        now: NOW,
      }),
    );
    const result = await db.transaction((tx) => applySettledFeeReview(tx, reviewInput()));
    expect(result.deltaCents).toBe(-20);
    const rows = await adjustments();
    expect(rows.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([-20, -10]);
    expect(rows.map((row) => row.sequence).sort()).toEqual([1, 2]);
    expect(await effectiveEarningCents(db, 1, 2940)).toBe(2910);
    expect((await audit()).deltaCents).toBe(0);
  });
});

describe("路由源码结构", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("fee-review / audit 路由都走事务体函数；audit 对 manual_review 的检查在事务体内", () => {
    const feeReview = read("../../app/api/admin/store-orders/[orderNo]/fee-review/route.ts");
    const auditRoute = read("../../app/api/admin/earnings/audit/route.ts");
    expect(feeReview).toContain("applySettledFeeReview(tx");
    expect(auditRoute).toContain("applyAuditCorrection(tx");
    const body = read("./fee-correction-db.ts");
    const auditBody = body.slice(body.indexOf("export async function applyAuditCorrection("));
    expect(auditBody.indexOf('feeReconcileStatus === "manual_review"')).toBeGreaterThan(-1);
    expect(auditBody.indexOf('feeReconcileStatus === "manual_review"')).toBeLessThan(auditBody.indexOf("insertOrderAdjustment(tx"));
    // fee-review 已结分支：条件更新（manual_review + paid + 未退款）先于写调整。
    const reviewBody = body.slice(body.indexOf("export async function applySettledFeeReview("), body.indexOf("export async function applyAuditCorrection("));
    expect(reviewBody.indexOf('eq(storeOrders.feeReconcileStatus, "manual_review")')).toBeLessThan(reviewBody.indexOf("insertOrderAdjustment(tx"));
    expect(reviewBody).toContain('eq(storeOrders.payStatus, "paid")');
    expect(reviewBody).toContain("isNull(storeOrders.refundedAt)");
    expect(reviewBody).not.toContain(".update(agentEarnings)");
  });
});
