import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkNoRevive, splitLocked, validateMarkPaid, type LockedLine } from "./reconciliation-core";

const reconciliation = readFileSync(new URL("./reconciliation.ts", import.meta.url), "utf8");
const agentList = readFileSync(new URL("../app/api/agent/reconciliations/route.ts", import.meta.url), "utf8");
const agentOne = readFileSync(new URL("../app/api/agent/reconciliations/[id]/route.ts", import.meta.url), "utf8");

const line = (over: Partial<LockedLine> & Pick<LockedLine, "sourceType" | "sourceId" | "amountCents">): LockedLine => ({
  sourceVersion: "v",
  ...over,
});

describe("锁定来源拆分", () => {
  it("纯旧周结 settling：只进 lockedLegacy，没有 settlementId 的计笔数但不进编号", () => {
    const res = splitLocked([
      line({ sourceType: "earning", sourceId: 1, amountCents: 1000, legacySettlementNo: "AS-1" }),
      line({ sourceType: "earning", sourceId: 2, amountCents: 500, legacySettlementNo: "AS-1" }),
      line({ sourceType: "adjustment", sourceId: 3, amountCents: -200, legacySettlementNo: "AS-2" }),
      line({ sourceType: "adjustment", sourceId: 4, amountCents: -100, legacySettlementNo: null }),
    ]);
    expect(res.lockedInBatch).toEqual({
      itemCount: 0, netCents: 0, storeEarningCents: 0, adjustmentCents: 0, drawDebtCents: 0, batchIds: [],
    });
    expect(res.lockedLegacy).toEqual({
      itemCount: 4, netCents: 1200, storeEarningCents: 1500, adjustmentCents: -300, settlementNos: ["AS-1", "AS-2"],
    });
  });

  it("纯批次 claim：提卡一定算批次内，batchIds 去重排序", () => {
    const res = splitLocked([
      line({ sourceType: "earning", sourceId: 1, amountCents: 1000, claimBatchId: 9 }),
      line({ sourceType: "adjustment", sourceId: 2, amountCents: -300, claimBatchId: 7 }),
      line({ sourceType: "draw_item", sourceId: 3, amountCents: 400, claimBatchId: 9 }),
      line({ sourceType: "draw_item", sourceId: 4, amountCents: 100, claimBatchId: null }),
    ]);
    expect(res.lockedInBatch).toEqual({
      itemCount: 4, netCents: 1000 - 300 - 500, storeEarningCents: 1000, adjustmentCents: -300, drawDebtCents: 500,
      batchIds: [7, 9],
    });
    expect(res.lockedLegacy).toEqual({
      itemCount: 0, netCents: 0, storeEarningCents: 0, adjustmentCents: 0, settlementNos: [],
    });
  });

  it("混合：两部分之和等于合计，不重复计数", () => {
    const rows = [
      line({ sourceType: "earning", sourceId: 1, amountCents: 800, claimBatchId: 5 }),
      line({ sourceType: "earning", sourceId: 2, amountCents: 600, legacySettlementNo: "AS-9" }),
      line({ sourceType: "adjustment", sourceId: 3, amountCents: -100, legacySettlementNo: "AS-9" }),
      line({ sourceType: "draw_item", sourceId: 4, amountCents: 250, claimBatchId: 5 }),
    ];
    const res = splitLocked(rows);
    expect(res.lockedInBatch.itemCount).toBe(2);
    expect(res.lockedInBatch.netCents).toBe(800 - 250);
    expect(res.lockedInBatch.batchIds).toEqual([5]);
    expect(res.lockedLegacy.itemCount).toBe(2);
    expect(res.lockedLegacy.netCents).toBe(500);
    expect(res.lockedLegacy.settlementNos).toEqual(["AS-9"]);
    expect(res.lockedInBatch.netCents + res.lockedLegacy.netCents).toBe(800 + 600 - 100 - 250);
  });

  it("loadLines 保留 claim 批次号并按 settlementId 关联旧周结单号；预览仍带合计 locked", () => {
    expect(reconciliation).toContain("batchId: agentReconciliationClaims.batchId");
    expect(reconciliation).toContain("earningSettlementId: agentEarnings.settlementId");
    expect(reconciliation).toContain("legacyNos.get(row.settlementId)");
    expect(reconciliation).toContain(".from(agentSettlements)");
    expect(reconciliation).toContain("lockedInBatch: view.lockedInBatch");
    expect(reconciliation).toContain("lockedLegacy: view.lockedLegacy");
    expect(reconciliation).toContain("lockedNetCents: view.lockedTotals.netCents");
    expect(reconciliation).toMatch(/locked: \{\s+netCents: view\.lockedTotals\.netCents/);
  });
});

describe("付款时间不能是未来", () => {
  const base = {
    netCents: 50000,
    direction: "platform_pays_agent",
    currency: "CNY",
    amountCents: 50000,
    paymentMethod: "bank",
    paymentReference: "BANK-1",
  };
  const now = Date.parse("2026-10-10T10:00:00Z");

  it("允许 5 分钟误差，再晚拒绝", () => {
    expect(validateMarkPaid({ ...base, actualPaymentAt: "2026-10-10T10:04:59Z" }, now).ok).toBe(true);
    expect(validateMarkPaid({ ...base, actualPaymentAt: "2026-10-10T09:00:00Z" }, now).ok).toBe(true);
    const res = validateMarkPaid({ ...base, actualPaymentAt: "2026-10-10T10:05:01Z" }, now);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("PAYMENT_REFERENCE_REQUIRED");
      expect(res.message).toBe("付款时间不能晚于现在");
    }
  });

  it("不传 now 时用当前时间", () => {
    expect(validateMarkPaid({ ...base, actualPaymentAt: new Date(Date.now() + 3600_000).toISOString() }).ok).toBe(false);
    expect(validateMarkPaid({ ...base, actualPaymentAt: new Date(Date.now() - 3600_000).toISOString() }).ok).toBe(true);
  });
});

describe("已退款订单不能被正数更正复活", () => {
  it.each(["refunded", "refunding", "chargeback"])("%s + 正数被拒，负数放行", (status) => {
    const res = checkNoRevive(status, 100);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("CORRECTION_EXCEEDS_EARNING");
      expect(res.message).toBe("这笔订单已退款，不能再增加代理收益；如需调整请先联系开发核对");
    }
    expect(checkNoRevive(status, -100).ok).toBe(true);
  });

  it("已付款订单正数照常放行", () => {
    expect(checkNoRevive("paid", 100).ok).toBe(true);
    expect(checkNoRevive("manual", 100).ok).toBe(true);
  });

  it("addCorrection 与 insertOrderAdjustment 都在上界校验前读订单状态", () => {
    const add = reconciliation.slice(reconciliation.indexOf("export async function addCorrection("));
    expect(add.indexOf("checkNoRevive(order.payStatus, input.amountCents)")).toBeGreaterThan(-1);
    expect(add.indexOf("checkNoRevive")).toBeLessThan(add.indexOf("checkCorrectionAmount(input.type"));
    const helper = reconciliation.slice(reconciliation.indexOf("export async function insertOrderAdjustment("));
    expect(helper.indexOf("checkNoRevive")).toBeGreaterThan(-1);
    expect(helper.indexOf("checkNoRevive")).toBeLessThan(helper.indexOf("checkAdjustmentFloor"));
  });
});

describe("代理端批次响应白名单", () => {
  it("两个代理端接口都走 agentBatchView，且视图不含内部字段", () => {
    expect(agentList).toContain("agentBatchView");
    expect(agentOne).toContain("agentBatchView(found.batch)");
    const view = reconciliation.slice(
      reconciliation.indexOf("export function agentBatchView("),
      reconciliation.indexOf("export async function listAgentBatches("),
    );
    for (const hidden of ["paymentNote", "createdBy", "snapshotHash", "agentId", "periodLabel"]) {
      expect(view).not.toMatch(new RegExp(`^\\s+${hidden}:`, "m"));
    }
    for (const kept of [
      "id", "batchNo", "status", "cutoffAt", "direction", "netCents", "storeEarningCents", "adjustmentCents",
      "drawDebtCents", "storeCount", "adjustmentCount", "drawCount", "createdAt", "paidAt", "cancelledAt",
      "paymentMethod", "paymentReference", "actualPaymentAt",
    ]) {
      expect(view).toMatch(new RegExp(`^\\s+${kept}: batch\\.${kept},`, "m"));
    }
  });
});
