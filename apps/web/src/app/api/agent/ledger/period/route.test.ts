import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

// Execute the actual CASE expressions used by both summary and detail queries.
const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const expressions = [...source.matchAll(/case when .*? end/g)]
  .map(([expression]) => expression.replace(/\$\{agentEarnings\.(\w+)\}/g, "$1"))
  .filter((expression) => expression.includes("FeeCents"));

describe("period fee compatibility", () => {
  it.each([
    { version: 1, total: 0, agent: 0, legacy: 99, expected: [0, 0, 0, 0] },
    { version: 1, total: 75, agent: 0, legacy: 99, expected: [75, 0, 75, 0] },
    { version: 0, total: 0, agent: 0, legacy: 99, expected: [99, 99, 99, 99] },
  ])("uses version $version, not fee amounts (total=$total, agent=$agent)", async (row) => {
    const client = createClient({ url: "file::memory:" });
    try {
      expect(expressions).toHaveLength(4);
      const result = await client.execute({
        sql: `SELECT ${expressions.map((expression, i) => `${expression} AS fee${i}`).join(", ")}
          FROM (SELECT ? AS feeFieldsVersion, ? AS totalFeeCents,
            ? AS agentFeeCents, ? AS paymentFeeCents)`,
        args: [row.version, row.total, row.agent, row.legacy],
      });
      expect(expressions.map((_, i) => Number(result.rows[0][`fee${i}`]))).toEqual(row.expected);
    } finally {
      client.close();
    }
  });
});
