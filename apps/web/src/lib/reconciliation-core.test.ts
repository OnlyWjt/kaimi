import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Execute the production pure helper without initializing DB/auth/Next dependencies.
const source = readFileSync(new URL("./reconciliation.ts", import.meta.url), "utf8");
const helper = source.slice(source.indexOf("export function effectiveAdjustmentCents("), source.indexOf("export async function effectiveEarningCents("));
const effectiveAdjustmentCents = new Function(ts.transpile(helper.replace("export function", "function")) + "\nreturn effectiveAdjustmentCents;")() as (
  earning: number, rows: Array<{ amountCents: number; status: string }>,
) => number;
import {
  adjustmentTypeForCorrection,
  agentEarningCents,
  assertCorrectionSequence,
  csvCell,
  directionOf,
  netCents,
  payloadHash,
  snapshotHash,
  totalsOf,
  legacyStoreSettlementCanRelease,
  validateClear,
  validateMarkPaid,
} from "./reconciliation-core";

describe("对账净额", () => {
  it("手续费多次更正聚合有效调整，撤销调整不进入基线", () => {
    expect(effectiveAdjustmentCents(1000, [
      { amountCents: 100, status: "pending" },
      { amountCents: -50, status: "settling" },
      { amountCents: 20, status: "settled" },
      { amountCents: 999, status: "cancelled" },
      { amountCents: -999, status: "reversed" },
    ])).toBe(1070);
  });

  it("新退款已扣部分收益，旧退款只补当前差额，重复退款差额为零", () => {
    const rows = [{ amountCents: 100, status: "settled" }, { amountCents: -1000, status: "pending" }];
    const refund = -effectiveAdjustmentCents(1000, rows);
    expect(refund).toBe(-100);
    expect(effectiveAdjustmentCents(1000, [...rows, { amountCents: refund, status: "pending" }])).toBe(0);
  });

  it("ACC-01 示例：商店 840 − 调整 40 − 提卡 300 = 平台应付 500", () => {
    expect(agentEarningCents({ goodsCents: 100000, agentCostCents: 70000, agentFeeCents: 2000 })).toBe(28000);
    expect(agentEarningCents({ goodsCents: 200000, agentCostCents: 140000, agentFeeCents: 4000 })).toBe(56000);
    const store = 28000 + 56000;
    const channel = 2000 + 4000 + 1000 + 2000;
    expect(store).toBe(84000);
    expect(channel).toBe(9000);
    expect(2000 + 4000 + 1000 + 2000).toBe(6000 + 3000);
    expect(netCents({ storeEarningCents: store, adjustmentCents: -4000, drawDebtCents: 30000 })).toBe(50000);
    expect(directionOf(50000)).toBe("platform_pays_agent");
  });

  it("ACC-02 负调整、只剩提卡、抵平方向分开", () => {
    expect(directionOf(netCents({ storeEarningCents: 0, adjustmentCents: -4000, drawDebtCents: 0 }))).toBe(
      "agent_pays_platform",
    );
    expect(directionOf(netCents({ storeEarningCents: 0, adjustmentCents: 0, drawDebtCents: 30000 }))).toBe(
      "agent_pays_platform",
    );
    expect(netCents({ storeEarningCents: 84000, adjustmentCents: -4000, drawDebtCents: 80000 })).toBe(0);
    expect(directionOf(0)).toBe("offset");
    expect(validateClear({ netCents: 0, hasPaymentFields: true }).ok).toBe(false);
    expect(validateClear({ netCents: 0, hasPaymentFields: false }).ok).toBe(true);
    expect(
      validateMarkPaid({
        netCents: 0,
        direction: "offset",
        currency: "CNY",
        amountCents: 0,
        paymentMethod: "alipay",
        paymentReference: "X",
        actualPaymentAt: "2026-10-10T09:00:00Z",
      }).ok,
    ).toBe(false);
  });

  it("新增行不改变旧快照哈希，改纳入行会变", () => {
    const base = [
      { sourceType: "earning" as const, sourceId: 1001, sourceVersion: "v1", amountCents: 28000 },
      { sourceType: "earning" as const, sourceId: 1002, sourceVersion: "v1", amountCents: 56000 },
      { sourceType: "adjustment" as const, sourceId: 1, sourceVersion: "v1", amountCents: -4000 },
      { sourceType: "draw_item" as const, sourceId: 1, sourceVersion: "v1", amountCents: 30000 },
    ];
    const first = snapshotHash(base);
    expect(snapshotHash([...base].reverse())).toBe(first);
    const withNew = snapshotHash([
      ...base,
      { sourceType: "earning", sourceId: 1003, sourceVersion: "v1", amountCents: 10000 },
    ]);
    expect(withNew).not.toBe(first);
    expect(totalsOf(base).netCents).toBe(50000);
    expect(totalsOf([...base, { sourceType: "earning", sourceId: 1003, sourceVersion: "v1", amountCents: 10000 }]).netCents).toBe(
      60000,
    );
  });

  it("同幂等键不同正文摘要不同，追踪字段不进摘要", () => {
    const a = payloadHash("mark_paid", { amountCents: 50000, requestId: "req-1" });
    const b = payloadHash("mark_paid", { requestId: "req-9", amountCents: 50000 });
    const c = payloadHash("mark_paid", { amountCents: 100, requestId: "req-1" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("更正序号只往后加，撤回过的序号不复用", () => {
    expect(assertCorrectionSequence([], 1)).toEqual({ ok: true, next: 1 });
    expect(assertCorrectionSequence([1], 2)).toEqual({ ok: true, next: 2 });
    expect(assertCorrectionSequence([1, 2], 2).ok).toBe(false);
    expect(adjustmentTypeForCorrection("fee_delta")).toBe("fee_correction");
    expect(adjustmentTypeForCorrection("refund")).toBe("refund");
  });

  it("CSV 给公式字符加前缀", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("正常")).toBe("正常");
    expect(csvCell('说"好"')).toBe(`"说""好"""`);
  });

  it("没打过款的旧周结可以退回，已返佣的不能退", () => {
    expect(legacyStoreSettlementCanRelease("pending_payment")).toBe(true);
    expect(legacyStoreSettlementCanRelease("draft")).toBe(true);
    expect(legacyStoreSettlementCanRelease("paid")).toBe(false);
    expect(legacyStoreSettlementCanRelease("cancelled")).toBe(false);
  });

  it("非零付款必须币种、方向、金额、方式和流水都对", () => {
    const ok = validateMarkPaid({
      netCents: 50000,
      direction: "platform_pays_agent",
      currency: "CNY",
      amountCents: 50000,
      paymentMethod: "bank",
      paymentReference: "BANK-20261010-88",
      actualPaymentAt: "2026-10-10T09:00:00Z",
    });
    expect(ok.ok).toBe(true);
    expect(
      validateMarkPaid({
        netCents: -30000,
        direction: "platform_pays_agent",
        currency: "CNY",
        amountCents: 30000,
        paymentMethod: "alipay",
        paymentReference: "A",
        actualPaymentAt: "2026-10-10T09:00:00Z",
      }).ok,
    ).toBe(false);
  });
});
