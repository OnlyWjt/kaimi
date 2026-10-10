import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import {
  adjustmentFingerprint,
  checkAdjustmentFloor,
  checkCorrectionAmount,
  cutoffInFuture,
  drawItemFingerprint,
  earningFingerprint,
  isFingerprintVersion,
} from "./reconciliation-core";

const draw = readFileSync(new URL("./agent-draw.ts", import.meta.url), "utf8");
const reconciliation = readFileSync(new URL("./reconciliation.ts", import.meta.url), "utf8");
const migrate = readFileSync(new URL("../db/migrate-lib.ts", import.meta.url), "utf8");

function fnBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("更正金额上界", () => {
  it("退款不能超过当前有效收益", () => {
    const res = checkCorrectionAmount("refund", -1200, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("CORRECTION_EXCEEDS_EARNING");
      expect(res.message).toContain("¥10.00");
    }
    expect(checkCorrectionAmount("reversal", -1001, 1000).ok).toBe(false);
  });

  it("有效收益为 0（已全额冲回）时拒绝退款/冲回", () => {
    expect(checkCorrectionAmount("refund", -1, 0).ok).toBe(false);
    expect(checkCorrectionAmount("reversal", -100, 0).ok).toBe(false);
  });

  it("退款/冲回必须为负，金额 0 一律拒绝", () => {
    expect(checkCorrectionAmount("refund", 100, 1000).ok).toBe(false);
    expect(checkCorrectionAmount("refund", 0, 1000).ok).toBe(false);
    expect(checkCorrectionAmount("fee_delta", 0, 1000).ok).toBe(false);
    expect(checkCorrectionAmount("manual", 0, 1000).ok).toBe(false);
  });

  it("fee_delta / manual 允许正负，但写入后有效收益不能 < 0", () => {
    expect(checkCorrectionAmount("fee_delta", -1001, 1000).ok).toBe(false);
    expect(checkCorrectionAmount("manual", -1, 0).ok).toBe(false);
    expect(checkCorrectionAmount("fee_delta", -1000, 1000).ok).toBe(true);
    expect(checkCorrectionAmount("fee_delta", 500, 1000).ok).toBe(true);
    expect(checkCorrectionAmount("manual", 300, 0).ok).toBe(true);
  });

  it("合法退款：部分与全额", () => {
    expect(checkCorrectionAmount("refund", -400, 1000).ok).toBe(true);
    expect(checkCorrectionAmount("refund", -1000, 1000).ok).toBe(true);
    expect(checkCorrectionAmount("reversal", -1, 1).ok).toBe(true);
  });

  it("通用调整下界：非 0 且写入后 ≥ 0", () => {
    expect(checkAdjustmentFloor(0, 1000).ok).toBe(false);
    expect(checkAdjustmentFloor(-1001, 1000).ok).toBe(false);
    expect(checkAdjustmentFloor(-1000, 1000).ok).toBe(true);
    expect(checkAdjustmentFloor(200, 0).ok).toBe(true);
  });

  it("addCorrection 在 existingEvent 重放之后、写入之前校验", () => {
    const body = fnBody(reconciliation, "export async function addCorrection(");
    const replayAt = body.indexOf("if (existingEvent) {");
    const checkAt = body.indexOf("checkCorrectionAmount(input.type, input.amountCents, effective)");
    const insertAt = body.indexOf(".insert(agentEarningAdjustments)");
    expect(replayAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(replayAt);
    expect(insertAt).toBeGreaterThan(checkAt);
    const helper = fnBody(reconciliation, "export async function insertOrderAdjustment(");
    expect(helper.indexOf("checkAdjustmentFloor")).toBeLessThan(helper.indexOf(".insert(agentEarningAdjustments)"));
  });
});

describe("来源版本指纹", () => {
  const earning = { earningCents: 2800, grossCents: 10000, costCents: 7000, agentFeeCents: 200, orderId: 9 };
  const adjustment = { amountCents: -400, type: "refund", orderId: 9, sequence: 1, sourceEarningId: 3 };
  const item = { amountCents: 3000, drawOrderId: 5, planKey: "plus" };

  it("只有 updatedAt 等无关字段变化时指纹不变", () => {
    expect(earningFingerprint({ ...earning, updatedAt: "2026-10-10T00:00:00Z", status: "settling" } as typeof earning))
      .toBe(earningFingerprint({ ...earning, updatedAt: "2026-10-11T00:00:00Z", status: "pending" } as typeof earning));
    expect(adjustmentFingerprint({ ...adjustment, updatedAt: "a", reason: "x" } as typeof adjustment))
      .toBe(adjustmentFingerprint({ ...adjustment, updatedAt: "b", reason: "y" } as typeof adjustment));
    expect(drawItemFingerprint({ ...item, updatedAt: "a", manualUsedAt: null } as typeof item))
      .toBe(drawItemFingerprint({ ...item, updatedAt: "b", manualUsedAt: "c" } as typeof item));
  });

  it("金额或归属字段变化时指纹变化", () => {
    const base = earningFingerprint(earning);
    expect(earningFingerprint({ ...earning, earningCents: 2700 })).not.toBe(base);
    expect(earningFingerprint({ ...earning, agentFeeCents: 300 })).not.toBe(base);
    expect(earningFingerprint({ ...earning, orderId: 10 })).not.toBe(base);
    expect(adjustmentFingerprint({ ...adjustment, amountCents: -500 })).not.toBe(adjustmentFingerprint(adjustment));
    expect(adjustmentFingerprint({ ...adjustment, sequence: 2 })).not.toBe(adjustmentFingerprint(adjustment));
    expect(drawItemFingerprint({ ...item, amountCents: 3100 })).not.toBe(drawItemFingerprint(item));
    expect(drawItemFingerprint({ ...item, planKey: "pro" })).not.toBe(drawItemFingerprint(item));
  });

  it("新指纹带 sha256: 前缀，旧 updatedAt 版本被识别为旧格式", () => {
    expect(isFingerprintVersion(earningFingerprint(earning))).toBe(true);
    expect(isFingerprintVersion("2026-10-10T09:00:00.000Z")).toBe(false);
  });

  it("loadLines / assertSourcesStable 不再使用 updatedAt 做版本", () => {
    expect(reconciliation).not.toMatch(/sourceVersion:\s*row\.(earning)?[uU]pdatedAt/);
    expect(reconciliation).not.toContain("updatedAt !== item.sourceVersion");
    const stable = reconciliation.slice(reconciliation.indexOf("async function assertSourcesStable"), reconciliation.indexOf("function assertVersion"));
    expect(stable).toContain("earningFingerprint(row)");
    expect(stable).toContain("adjustmentFingerprint(row)");
    expect(stable).toContain("drawItemFingerprint(row)");
  });
});

describe("截止时间", () => {
  it("允许 2 分钟误差，再晚拒绝", () => {
    const now = Date.parse("2026-10-10T10:00:00Z");
    expect(cutoffInFuture("2026-10-10T10:01:59Z", now)).toBe(false);
    expect(cutoffInFuture("2026-10-10T09:00:00Z", now)).toBe(false);
    expect(cutoffInFuture("2026-10-10T10:02:01Z", now)).toBe(true);
  });
});

describe("提卡写入口与对账占用", () => {
  it("void / manualUse 在调用卡台前检查 active claim，事务内再用 NOT EXISTS 条件写", () => {
    for (const signature of ["export async function voidDrawItem(", "export async function manualUseDrawItem("]) {
      const body = fnBody(draw, signature);
      const precheck = body.indexOf("drawItemInActiveBatch(db, row.id)");
      const upstream = body.indexOf("refundDrawCardUpstream(row)");
      const inTx = body.indexOf("drawItemInActiveBatch(tx, row.id)");
      expect(precheck).toBeGreaterThan(-1);
      expect(upstream).toBeGreaterThan(precheck);
      expect(inTx).toBeGreaterThan(upstream);
      expect(body).toContain("noActiveDrawClaim");
    }
  });

  it("旧单独结提卡入口直接拒绝", () => {
    const body = fnBody(draw, "export async function settleDrawItems(");
    expect(body).toContain("提卡已并入对账");
    expect(body).not.toContain(".insert(agentDrawBills)");
  });

  it("NOT EXISTS 条件只被 active claim 挡住", async () => {
    const match = draw.match(/const noActiveDrawClaim = sql`([\s\S]*?)`;/);
    expect(match).toBeTruthy();
    const predicate = match![1].replace("${agentDrawItems.id}", "agent_draw_items.id");
    const client = createClient({ url: "file::memory:" });
    try {
      await client.executeMultiple(`
        CREATE TABLE agent_draw_items (id INTEGER PRIMARY KEY, status TEXT);
        CREATE TABLE agent_reconciliation_claims (id INTEGER PRIMARY KEY, source_type TEXT, source_id INTEGER, batch_id INTEGER, claim_state TEXT);
        INSERT INTO agent_draw_items VALUES (1, 'unsettled'), (2, 'unsettled'), (3, 'unsettled');
        INSERT INTO agent_reconciliation_claims VALUES (1, 'draw_item', 1, 7, 'active');
        INSERT INTO agent_reconciliation_claims VALUES (2, 'draw_item', 2, 6, 'settled');
        INSERT INTO agent_reconciliation_claims VALUES (3, 'earning', 3, 7, 'active');
      `);
      const voided = await client.execute(`UPDATE agent_draw_items SET status = 'void'
        WHERE status = 'unsettled' AND ${predicate} RETURNING id`);
      expect(voided.rows.map((row) => Number(row.id)).sort()).toEqual([2, 3]);
      // 检查之后才被占用：条件写入更新 0 行，调用方据此抛 409。
      await client.execute("UPDATE agent_draw_items SET status = 'unsettled' WHERE id = 3");
      await client.execute("INSERT INTO agent_reconciliation_claims VALUES (4, 'draw_item', 3, 8, 'active')");
      const late = await client.execute(`UPDATE agent_draw_items SET status = 'void'
        WHERE id = 3 AND status = 'unsettled' AND ${predicate} RETURNING id`);
      expect(late.rows).toHaveLength(0);
    } finally {
      client.close();
    }
  });
});

describe("状态机与镜像", () => {
  it("confirm / cancel / settle 的批次更新都带 version+status 条件并检查影响行数", () => {
    const patch = fnBody(reconciliation, "export async function patchReconciliation(");
    const settle = reconciliation.slice(reconciliation.indexOf("async function settleBatch("), reconciliation.indexOf("export async function addCorrection("));
    for (const part of [patch, settle]) {
      expect(part).toContain("eq(agentReconciliationBatches.version, batch.version)");
    }
    expect(patch).toContain("const confirmed = await tx");
    expect(patch).toContain("if (!confirmed.length)");
    expect(patch).toContain("const cancelled = await tx");
    expect(patch).toContain("if (!cancelled.length)");
    expect(settle).toContain("if (!finished.length)");
  });

  it("镜像行只在含商店收益/调整时写，金额为商店侧口径", () => {
    const settle = reconciliation.slice(reconciliation.indexOf("async function settleBatch("), reconciliation.indexOf("export async function addCorrection("));
    expect(settle).toContain("if (earningIds.length || adjustmentIds.length)");
    expect(settle).toContain("batch.storeEarningCents + batch.adjustmentCents");
    expect(settle).not.toContain("amountCents: batch.netCents");
    expect(settle).toContain("settlementNo: batch.batchNo");
  });

  it("迁移不再自动取消旧待返佣单", () => {
    expect(migrate).not.toContain("releaseUnpaidLegacyStoreSettlements()");
    expect(migrate).not.toMatch(/UPDATE agent_settlements\s+SET status = 'cancelled'/);
  });
});
