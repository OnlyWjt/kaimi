import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { beijingPeriodBounds } from "../../../../../lib/agent-console-core";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

function summaryExpression(name: string) {
  const match = source.match(new RegExp(`\\b${name}: sql<number>\`(.*?)\`,`));
  if (!match) throw new Error(`missing ${name}`);
  return match[1].replace(/\$\{agentEarnings\.(\w+)\}/g, "$1");
}

async function withRows<T>(
  rows: Array<{ confirmedAt: string; status: string; earningCents: number }>,
  run: (client: ReturnType<typeof createClient>) => Promise<T>,
) {
  const client = createClient({ url: "file::memory:" });
  try {
    await client.execute("CREATE TABLE e (confirmedAt TEXT, status TEXT, earningCents INTEGER)");
    for (const row of rows) {
      await client.execute({
        sql: "INSERT INTO e VALUES (?, ?, ?)",
        args: [row.confirmedAt, row.status, row.earningCents],
      });
    }
    return await run(client);
  } finally {
    client.close();
  }
}

describe("period 边界 [start, end)", () => {
  it("route 用 gte/lt，不再用 lte", () => {
    expect(source).toContain("gte(agentEarnings.confirmedAt, start)");
    expect(source).toContain("lt(agentEarnings.confirmedAt, end)");
    expect(source).not.toMatch(/lte\(agentEarnings\.confirmedAt/);
  });

  it("选「今天」时恰在次日 0 点（北京）的记录不计入", async () => {
    const { start, end } = beijingPeriodBounds("2026-09-02", "2026-09-02");
    const count = await withRows(
      [
        { confirmedAt: "2026-09-01T15:59:59.999Z", status: "pending", earningCents: 1 },
        { confirmedAt: "2026-09-01T16:00:00.000Z", status: "pending", earningCents: 10 },
        { confirmedAt: "2026-09-02T15:59:59.999Z", status: "pending", earningCents: 100 },
        { confirmedAt: "2026-09-02T16:00:00.000Z", status: "pending", earningCents: 1000 },
      ],
      async (client) => {
        const result = await client.execute({
          sql: "SELECT coalesce(sum(earningCents), 0) AS total FROM e WHERE confirmedAt >= ? AND confirmedAt < ?",
          args: [start, end],
        });
        return Number(result.rows[0].total);
      },
    );
    expect(count).toBe(110);
  });
});

describe("period 收益合计排除 reversed", () => {
  it("earningCents 不含已冲回，reversedCents 单列", async () => {
    const earning = summaryExpression("earningCents");
    const reversed = summaryExpression("reversedCents");
    const reversedCount = summaryExpression("reversedCount");
    const pending = summaryExpression("pendingCents");
    const row = await withRows(
      [
        { confirmedAt: "2026-09-02T01:00:00.000Z", status: "pending", earningCents: 28000 },
        { confirmedAt: "2026-09-02T02:00:00.000Z", status: "settled", earningCents: 56000 },
        { confirmedAt: "2026-09-02T03:00:00.000Z", status: "reversed", earningCents: 10000 },
      ],
      async (client) => {
        const result = await client.execute(
          `SELECT ${earning} AS earning, ${reversed} AS reversed, ${reversedCount} AS reversedCount, ${pending} AS pending FROM e`,
        );
        return result.rows[0];
      },
    );
    expect(Number(row.earning)).toBe(84000);
    expect(Number(row.reversed)).toBe(10000);
    expect(Number(row.reversedCount)).toBe(1);
    expect(Number(row.pending)).toBe(28000);
  });
});
