import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beijingPeriodBounds } from "../agent-console-core";
import { computeOrderLedger, ledgerInputFromOrder, verifyLedger } from "../order-ledger-core";
import {
  FEE_REVIEW_SETTLING_MESSAGE,
  LOCKED_EARNING_FEE_MESSAGE,
  RECALC_SETTLED_MESSAGE,
  RECALC_SETTLING_MESSAGE,
  auditCorrectionEventKey,
  earningLockState,
  feeCorrectionDelta,
  feeReviewEventKey,
  NO_LOCKED_EARNING_SQL,
} from "./fee-lock-core";
import { writeOrderFee } from "./fee-lock-db";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const reconcile = read("./reconcile.ts");
const recalculate = read("./recalculate.ts");
const feeReview = read("../../app/api/admin/store-orders/[orderNo]/fee-review/route.ts");
const audit = read("../../app/api/admin/earnings/audit/route.ts");
const exportRoute = read("../../app/api/agent/earnings/export.xlsx/route.ts");
const reconciliation = read("../reconciliation.ts");

// reconciliation.ts 依赖 @/db，测试里不能直接 import；取出纯函数源码按同样规则验证。
function effectiveAdjustmentCents(earningCents: number, adjustments: Array<{ amountCents: number; status: string }>) {
  expect(reconciliation).toContain('.filter((row) => ["pending", "settling", "settled"].includes(row.status))');
  return earningCents + adjustments
    .filter((row) => ["pending", "settling", "settled"].includes(row.status))
    .reduce((sum, row) => sum + row.amountCents, 0);
}

// 订单：实付 10000，成本 7000，费率 0.6%，估算手续费 60 → 代理收益 2940。
const ORDER = {
  grossCents: 10000,
  invoiceSurchargeCents: 0,
  agentCostTotalCents: 7000,
  upstreamCostTotalCents: 6000,
  feeRatePpm: 6000,
  fixedFeeCents: 0,
};
const estimate = computeOrderLedger(ledgerInputFromOrder(ORDER));
const gateway = computeOrderLedger(ledgerInputFromOrder(ORDER), { gatewayFeeCents: 90 });

const SCHEMA = `
  CREATE TABLE store_orders (
    id INTEGER PRIMARY KEY,
    fee_reconcile_status TEXT NOT NULL,
    fee_reconcile_attempts INTEGER NOT NULL DEFAULT 0,
    fee_reconcile_last_error TEXT NOT NULL DEFAULT '',
    fee_reconciled_at TEXT,
    actual_payment_fee_cents INTEGER,
    final_payment_fee_cents INTEGER NOT NULL,
    agent_fee_cents INTEGER NOT NULL,
    platform_fee_cents INTEGER NOT NULL,
    agent_earning_cents INTEGER NOT NULL,
    platform_profit_cents INTEGER,
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE agent_earnings (
    id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, status TEXT NOT NULL, settlement_id INTEGER
  );
`;

async function seed(client: Client, earning: { status: string; settlementId?: number | null } | null) {
  await client.execute({
    sql: `INSERT INTO store_orders (id, fee_reconcile_status, final_payment_fee_cents, agent_fee_cents,
      platform_fee_cents, agent_earning_cents, platform_profit_cents) VALUES (1, 'pending', ?, ?, ?, ?, ?)`,
    args: [
      estimate.finalPaymentFeeCents,
      estimate.agentFeeCents,
      estimate.platformFeeCents,
      estimate.agentEarningCents,
      estimate.platformProfitCents,
    ],
  });
  if (earning) {
    await client.execute({
      sql: "INSERT INTO agent_earnings (id, order_id, status, settlement_id) VALUES (1, 1, ?, ?)",
      args: [earning.status, earning.settlementId ?? null],
    });
  }
}

async function orderRow(client: Client) {
  const { rows } = await client.execute("SELECT * FROM store_orders WHERE id = 1");
  return rows[0]!;
}

function input(ledger = gateway, actualFee: number | null = 90) {
  return {
    orderId: 1,
    reconcilableStatuses: ["pending", "retrying"],
    actualFee,
    attemptNo: 2,
    now: "2026-10-10T00:00:00.000Z",
    finalStatus: "confirmed" as const,
    ledger,
  };
}

describe("reconcile 手续费回写：收益锁定时不改订单金额", () => {
  let client: Client;
  beforeEach(async () => {
    client = createClient({ url: "file::memory:" });
    await client.executeMultiple(SCHEMA);
  });
  afterEach(() => client.close());

  it.each([
    ["无收益行", null],
    ["pending 收益", { status: "pending" }],
  ])("%s：照常同步订单金额", async (_label, earning) => {
    await seed(client, earning);
    const outcome = await writeOrderFee(drizzle(client), input());
    expect(outcome).toEqual({ kind: "applied" });
    const row = await orderRow(client);
    expect(Number(row.agent_earning_cents)).toBe(gateway.agentEarningCents);
    expect(Number(row.final_payment_fee_cents)).toBe(90);
    expect(Number(row.actual_payment_fee_cents)).toBe(90);
    expect(row.fee_reconcile_status).toBe("confirmed");
  });

  it.each([
    ["settling", { status: "settling" }],
    ["settled", { status: "settled" }],
    ["pending 但挂旧结算单", { status: "pending", settlementId: 7 }],
    ["reversed", { status: "reversed" }],
  ])("%s：订单金额字段不变，转 manual_review，只记网关手续费", async (_label, earning) => {
    await seed(client, earning);
    const before = await orderRow(client);
    const outcome = await writeOrderFee(drizzle(client), input());
    expect(outcome).toEqual({ kind: "locked", status: "manual_review" });
    const row = await orderRow(client);
    for (const column of [
      "final_payment_fee_cents",
      "agent_fee_cents",
      "platform_fee_cents",
      "agent_earning_cents",
      "platform_profit_cents",
    ]) {
      expect(row[column]).toBe(before[column]);
    }
    expect(Number(row.actual_payment_fee_cents)).toBe(90);
    expect(row.fee_reconcile_status).toBe("manual_review");
    expect(row.fee_reconcile_last_error).toBe(LOCKED_EARNING_FEE_MESSAGE);
    // 订单仍和收益行快照一致（不会被 loadLines 判 LEDGER_MISMATCH）。
    expect(verifyLedger({ ...ORDER, ...estimate })).toEqual([]);
  });

  it("锁定但金额无差额（unsupported 回退按估算）：不制造人工单，金额不动", async () => {
    await seed(client, { status: "settled" });
    const outcome = await writeOrderFee(drizzle(client), {
      ...input(estimate, null),
      finalStatus: "unsupported",
    });
    expect(outcome).toEqual({ kind: "locked", status: "unsupported" });
    const row = await orderRow(client);
    expect(row.fee_reconcile_status).toBe("unsupported");
    expect(row.actual_payment_fee_cents).toBeNull();
    expect(Number(row.agent_earning_cents)).toBe(estimate.agentEarningCents);
  });

  it("订单状态已被别处改走：两条条件更新都不命中 → skipped", async () => {
    await seed(client, { status: "settling" });
    await client.execute("UPDATE store_orders SET fee_reconcile_status = 'confirmed'");
    expect(await writeOrderFee(drizzle(client), input())).toEqual({ kind: "skipped" });
    expect((await orderRow(client)).fee_reconcile_status).toBe("confirmed");
  });

  it("NOT EXISTS 条件在写入时才判断：选中后收益被批次占用，金额更新 0 行", async () => {
    await seed(client, { status: "pending" });
    await client.execute("UPDATE agent_earnings SET status = 'settling'");
    const res = await client.execute(
      `UPDATE store_orders SET agent_earning_cents = 1 WHERE id = 1 AND ${NO_LOCKED_EARNING_SQL} RETURNING id`,
    );
    expect(res.rows).toHaveLength(0);
  });

  it("成功分支与 unsupported 回退分支都走 writeOrderFee，收益行只在 applied 后同步", () => {
    expect(reconcile.match(/writeOrderFee\(tx, \{/g)).toHaveLength(2);
    expect(reconcile).not.toMatch(/\.update\(storeOrders\)\s*\.set\(\{\s*(actualPaymentFeeCents: actualFee,\s*)?finalPaymentFeeCents/);
    expect(reconcile).toContain('const updatedOrder = outcome.kind === "applied";');
    expect(reconcile).toContain("if (!updatedOrder) return;");
  });

  it("manual_review 订单在 loadLines 里被跳过；已 settling 的先归 locked（批次照快照付）", () => {
    const load = reconciliation.slice(
      reconciliation.indexOf("async function loadLines("),
      reconciliation.indexOf("for (const row of missing)"),
    );
    const lockedAt = load.indexOf('row.earningStatus === "settling"');
    const reviewAt = load.indexOf('row.feeReconcileStatus === "manual_review"');
    expect(lockedAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(lockedAt);
    expect(load).toContain('skipCode: "MANUAL_REVIEW_REQUIRED"');
  });
});

describe("收益锁定状态", () => {
  it("区分 open / settling / settled / other", () => {
    expect(earningLockState(null)).toBe("none");
    expect(earningLockState({ status: "pending", settlementId: null })).toBe("open");
    expect(earningLockState({ status: "pending", settlementId: 3 })).toBe("other");
    expect(earningLockState({ status: "settling", settlementId: null })).toBe("settling");
    expect(earningLockState({ status: "settled", settlementId: 3 })).toBe("settled");
    expect(earningLockState({ status: "reversed", settlementId: null })).toBe("other");
  });
});

describe("fee-review 已结算分支", () => {
  it("差额 = 按网关值的新收益 − 当前有效收益（含已有调整）", () => {
    const earningCents = estimate.agentEarningCents; // 2940
    expect(gateway.agentEarningCents).toBe(2910);
    expect(feeCorrectionDelta(gateway.agentEarningCents, effectiveAdjustmentCents(earningCents, []))).toBe(-30);
    // 已有一笔 -10 的有效调整、一笔撤销的调整（不计）：只差 -20。
    const effective = effectiveAdjustmentCents(earningCents, [
      { amountCents: -10, status: "settled" },
      { amountCents: -500, status: "cancelled" },
    ]);
    expect(feeCorrectionDelta(gateway.agentEarningCents, effective)).toBe(-20);
  });

  it("事件键稳定：同一对账记录 / 同一网关手续费得到同一个键", () => {
    expect(feeReviewEventKey(5, { reconciliationId: 12, actualFeeCents: 90 })).toBe(
      feeReviewEventKey(5, { reconciliationId: 12, actualFeeCents: 90 }),
    );
    expect(feeReviewEventKey(5, { reconciliationId: null, actualFeeCents: 90 })).toBe("fee-review:5:fee90");
    expect(feeReviewEventKey(5, { reconciliationId: 12, actualFeeCents: 90 })).toBe("fee-review:5:rec12");
  });

  it("settling 返回 409；settled 走 applySettledFeeReview（内部 insertOrderAdjustment，收益行不改）；ReconciliationError 转 JSON", () => {
    expect(FEE_REVIEW_SETTLING_MESSAGE).toBe("这单在对账批次中，先结清或取消批次再处理手续费");
    expect(feeReview).toContain('if (lockState === "settling")');
    const settled = feeReview.slice(
      feeReview.indexOf("async function settledFeeReview("),
      feeReview.indexOf("export async function POST("),
    );
    expect(settled).toContain("applySettledFeeReview(tx");
    expect(settled).toContain("error instanceof ReconciliationError");
    expect(settled).not.toContain(".update(agentEarnings)");
    const body = read("./fee-correction-db.ts");
    expect(body).toContain('type: "fee_correction"');
    expect(body).toContain("feeReviewEventKey(input.orderId");
  });
});

describe("earnings/audit 已结修正事件键", () => {
  it("状态不变时稳定，E 变化后得到新键", () => {
    const first = auditCorrectionEventKey(9, 2910, 2940);
    expect(first).toBe("audit:9:2910:2940");
    expect(auditCorrectionEventKey(9, 2910, 2940)).toBe(first);
    // 修正 -30 后 E=2910，目标变成 2880（订单快照又被纠正）：新键。
    expect(auditCorrectionEventKey(9, 2880, 2910)).not.toBe(first);
    expect(feeCorrectionDelta(2880, 2910)).toBe(-30);
  });

  it("改用 insertOrderAdjustment + replayed，去掉 legacy 键与 createdAt 判断", () => {
    const settled = audit.slice(audit.indexOf('if (earning?.status === "settled")'), audit.indexOf("try {\n  await db.transaction"));
    expect(settled).toContain("applyAuditCorrection(tx");
    expect(settled).toContain("replayed: true");
    expect(settled).toContain("unchanged: true");
    const body = read("./fee-correction-db.ts");
    const auditBody = body.slice(body.indexOf("export async function applyAuditCorrection("));
    expect(auditBody).toContain("insertOrderAdjustment(tx");
    expect(auditBody).toContain("auditCorrectionEventKey(input.orderId, target, effective)");
    expect(auditBody).toContain('currentOrder.payStatus !== "paid"');
    expect(audit).not.toContain("insertLegacyAdjustment");
    expect(body).not.toContain("insertLegacyAdjustment(tx");
    expect(auditBody).not.toContain("createdAt !==");
  });
});

describe("recalculate 提示与条件写", () => {
  it("锁定收益的提示文案，订单更新带 NOT EXISTS 已锁定收益", () => {
    expect(RECALC_SETTLING_MESSAGE).toBe("这单在对账批次中，先取消批次");
    expect(RECALC_SETTLED_MESSAGE).toBe("已结算，差额请走手续费更正");
    expect(recalculate).toContain("sql.raw(NO_LOCKED_EARNING_SQL)");
    expect(recalculate).toContain("if (!updatedOrder) return false;");
  });
});

describe("代理收益导出期间口径", () => {
  it("使用 beijingPeriodBounds + gte/lt，不再用 lte", () => {
    expect(exportRoute).toContain("beijingPeriodBounds(");
    expect(exportRoute).toContain("lt(agentEarnings.confirmedAt, end)");
    expect(exportRoute).not.toMatch(/\blte\(/);
    expect(exportRoute).not.toContain("periodBoundary");
  });

  it("恰在结束点的记录不计入，开始点计入；reversed 不进收益合计", async () => {
    const { start, end } = beijingPeriodBounds("2026-10-01", "2026-10-07");
    expect(start).toBe("2026-09-30T16:00:00.000Z");
    expect(end).toBe("2026-10-07T16:00:00.000Z");
    const client = createClient({ url: "file::memory:" });
    try {
      await client.executeMultiple(`
        CREATE TABLE agent_earnings (id INTEGER PRIMARY KEY, confirmed_at TEXT, status TEXT, earning_cents INTEGER);
        INSERT INTO agent_earnings VALUES
          (1, '2026-09-30T15:59:59.999Z', 'pending', 1),
          (2, '2026-09-30T16:00:00.000Z', 'pending', 10),
          (3, '2026-10-07T15:59:59.999Z', 'settled', 100),
          (4, '2026-10-07T16:00:00.000Z', 'pending', 1000),
          (5, '2026-10-03T00:00:00.000Z', 'reversed', 10000);
      `);
      const { rows } = await client.execute({
        sql: `SELECT group_concat(id) AS ids,
          sum(CASE WHEN status != 'reversed' THEN earning_cents ELSE 0 END) AS earning
          FROM (SELECT * FROM agent_earnings WHERE confirmed_at >= ? AND confirmed_at < ? ORDER BY id)`,
        args: [start, end],
      });
      expect(String(rows[0]!.ids)).toBe("2,3,5");
      expect(Number(rows[0]!.earning)).toBe(110);
    } finally {
      client.close();
    }
  });
});
