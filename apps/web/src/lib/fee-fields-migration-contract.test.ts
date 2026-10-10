import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../db/migrate-lib.ts", import.meta.url), "utf8");

describe("fee fields migration contract", () => {
  it("marks successfully ledger-recomputed legacy rows as version 1", () => {
    const block = source.slice(source.indexOf("async function ensureFeeFieldsVersion"), source.indexOf("async function restoreSettledFeeColumn"));
    expect(block).toContain("feeFieldsVersion: 1");
    expect(block).toContain("agentFeeCents: ledger.agentFeeCents");
    expect(block).toContain("totalFeeCents: ledger.finalPaymentFeeCents");
    expect(block).toContain("if (row.feeFieldsVersion !== 0) continue");
  });

  it("keeps settled restoration separate from agent fee migration", () => {
    const restore = source.slice(source.indexOf("async function restoreSettledFeeColumn"), source.indexOf("async function ensureRedeemGuardSchema"));
    expect(restore).toContain("SET payment_fee_cents = total_fee_cents");
    expect(restore).not.toContain("agent_fee_cents = total_fee_cents");
  });
});
