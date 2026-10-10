import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

const reconciliation = readFileSync(new URL("./reconciliation.ts", import.meta.url), "utf8");
const legacy = readFileSync(new URL("./agent-settlement.ts", import.meta.url), "utf8");
const predicates = (source: string) => [...source.matchAll(/sql`(EXISTS \([\s\S]*?\))`/g)]
  .map(([, predicate]) => predicate.replace(/\$\{agentEarningAdjustments.orderId\}/g, "agent_earning_adjustments.order_id"))
  .filter((predicate) => predicate.includes("agent_earning_adjustments.order_id"));

describe("refund / settlement adjustment query contract", () => {
  it("guards both reconciliation loading and claiming, plus legacy claiming", () => {
    expect(predicates(reconciliation)).toHaveLength(2);
    expect(predicates(legacy)).toHaveLength(1);
    const legacyLoad = legacy.slice(legacy.indexOf("const adjustmentRows"), legacy.indexOf("const skippedManualReview"));
    expect(legacyLoad).toContain(".innerJoin(storeOrders, eq(storeOrders.id, agentEarningAdjustments.orderId))");
    expect(legacyLoad).toContain('ne(storeOrders.payStatus, "refunding")');
    // Effective earnings and settled history must still include refund adjustments.
    const effective = reconciliation.slice(reconciliation.indexOf("export async function effectiveEarningCents"));
    expect(effective).not.toContain("store_orders.pay_status");
  });

  it.each(["paid", "refunding", "refunded", "unpaid"])("checks current order status %s even after selection", async (status) => {
    const client = createClient({ url: "file::memory:" });
    try {
      await client.executeMultiple(`
        CREATE TABLE store_orders (id INTEGER PRIMARY KEY, pay_status TEXT);
        CREATE TABLE agent_earning_adjustments (id INTEGER PRIMARY KEY, order_id INTEGER, status TEXT, type TEXT, amount_cents INTEGER);
        INSERT INTO store_orders VALUES (1, 'paid');
        INSERT INTO agent_earning_adjustments VALUES (1, 1, 'pending', 'refund', -100);
        INSERT INTO agent_earning_adjustments VALUES (2, 999, 'pending', 'refund', -100);
      `);
      // Simulate the order changing after a preview selected adjustment id 1.
      await client.execute({ sql: "UPDATE store_orders SET pay_status = ? WHERE id = 1", args: [status] });
      for (const predicate of [...predicates(reconciliation), ...predicates(legacy)]) {
        const selected = await client.execute(`SELECT id FROM agent_earning_adjustments WHERE ${predicate}`);
        expect(selected.rows).toHaveLength(status === "refunding" ? 0 : 1);
        const claimed = await client.execute(`UPDATE agent_earning_adjustments SET status = 'settling'
          WHERE id = 1 AND status = 'pending' AND ${predicate} RETURNING id`);
        expect(claimed.rows).toHaveLength(status === "refunding" ? 0 : 1);
        await client.execute("UPDATE agent_earning_adjustments SET status = 'pending'");
      }
    } finally {
      client.close();
    }
  });
});
