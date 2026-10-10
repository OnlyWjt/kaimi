import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const notExists = source.match(/sql`(NOT EXISTS \(.*?\))`/)?.[1]
  .replace(/\$\{agentSettlements\.settlementNo\}/g, "agent_settlements.settlement_no");

describe("agent settlements 排除对账镜像行", () => {
  it("按 session.agentId 过滤，并用 NOT EXISTS 关联批次号", () => {
    expect(source).toContain("eq(agentSettlements.agentId, session.agentId)");
    expect(notExists).toMatch(/agent_reconciliation_batches/);
  });

  it("settlement_no 等于某个 batch_no 的行被排除，前缀相同但不是批次号的保留", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await client.execute("CREATE TABLE agent_settlements (id INTEGER, agent_id INTEGER, settlement_no TEXT)");
      await client.execute("CREATE TABLE agent_reconciliation_batches (id INTEGER, agent_id INTEGER, batch_no TEXT)");
      await client.execute(`INSERT INTO agent_settlements VALUES
        (1, 7, 'ST-2026-01'), (2, 7, 'RC-AAA'), (3, 7, 'RC-NOT-A-BATCH'), (4, 8, 'ST-OTHER')`);
      await client.execute("INSERT INTO agent_reconciliation_batches VALUES (1, 7, 'RC-AAA')");
      const result = await client.execute({
        sql: `SELECT id FROM agent_settlements WHERE agent_id = ? AND ${notExists} ORDER BY id`,
        args: [7],
      });
      expect(result.rows.map((row) => Number(row.id))).toEqual([1, 3]);
    } finally {
      client.close();
    }
  });
});
