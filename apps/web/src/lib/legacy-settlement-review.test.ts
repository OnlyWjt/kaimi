import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowedFromStatuses,
  BAD_STATE_MESSAGE,
  MIRROR_MESSAGE,
  reviewLegacySettlement,
  STATE_CHANGED_MESSAGE,
} from "./legacy-settlement-review";

const SCHEMA = `
  CREATE TABLE agent_settlements (
    id INTEGER PRIMARY KEY,
    settlement_no TEXT NOT NULL,
    agent_id INTEGER NOT NULL,
    period_start TEXT NOT NULL DEFAULT '',
    period_end TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    payment_method TEXT NOT NULL DEFAULT '',
    payment_reference TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    paid_at TEXT
  );
  CREATE TABLE agent_reconciliation_batches (
    id INTEGER PRIMARY KEY,
    batch_no TEXT NOT NULL
  );
  CREATE TABLE agent_earnings (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    settlement_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE agent_earning_adjustments (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    settlement_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT ''
  );
`;

// 用固定文件名的临时库，不用 file::memory:。本机实测：走过 db.transaction() 之后，
// file::memory: 的库里表就没了（事务结束后 client 换了新连接），后面的断言查不到数据。
// Windows 上文件句柄关闭后不一定立刻释放，所以固定一个文件名、每个用例重建表，而不是每次建临时目录。
const DB_FILE = join(tmpdir(), "kaimi-legacy-settlement-review-test.db").replace(/\\/g, "/");
const DROP_ALL = `
  DROP TABLE IF EXISTS agent_settlements;
  DROP TABLE IF EXISTS agent_reconciliation_batches;
  DROP TABLE IF EXISTS agent_earnings;
  DROP TABLE IF EXISTS agent_earning_adjustments;
`;

describe("旧周结单核验", () => {
  let client: Client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  beforeEach(async () => {
    client = createClient({ url: `file:${DB_FILE}` });
    db = drizzle(client);
    await client.executeMultiple(DROP_ALL + SCHEMA);
  });
  afterEach(() => client.close());
  afterAll(() => {
    try {
      rmSync(DB_FILE, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行会覆盖同名文件 */
    }
  });

  describe("allowedFromStatuses", () => {
    it("mark_paid 只认已出付款单的 pending_payment", () => {
      expect(allowedFromStatuses("mark_paid")).toEqual(["pending_payment"]);
    });
    it("cancel 也认 draft（退回占用的收益）", () => {
      expect(allowedFromStatuses("cancel")).toContain("draft");
      expect(allowedFromStatuses("cancel")).toContain("pending_payment");
    });
  });

  describe("reviewLegacySettlement", () => {
    it("不存在的单 → not_found", async () => {
      const result = await reviewLegacySettlement(db, 999, { action: "cancel" }, "2026-01-01T00:00:00Z");
      expect(result).toEqual({ kind: "not_found" });
    });

    it("对账批次镜像行 → mirror", async () => {
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (1, 'RC-AAA', 7, 10000, 'paid')");
      await client.execute("INSERT INTO agent_reconciliation_batches (id, batch_no) VALUES (1, 'RC-AAA')");
      const result = await reviewLegacySettlement(db, 1, { action: "cancel" }, "2026-01-01T00:00:00Z");
      expect(result).toEqual({ kind: "mirror" });
    });

    it("状态不可操作 → bad_state (mark_paid 遇到 draft)", async () => {
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (1, 'ST-01', 7, 10000, 'draft')");
      const result = await reviewLegacySettlement(
        db,
        1,
        { action: "mark_paid", paymentMethod: "支付宝", paymentReference: "R123" },
        "2026-01-01T00:00:00Z",
      );
      expect(result).toEqual({ kind: "bad_state" });
    });

    it("状态不可操作 → bad_state (已 paid / cancelled)", async () => {
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (1, 'ST-01', 7, 10000, 'paid')");
      const result = await reviewLegacySettlement(db, 1, { action: "cancel" }, "2026-01-01T00:00:00Z");
      expect(result).toEqual({ kind: "bad_state" });
    });

    it("mark_paid: pending_payment → paid，并把 settling 收益/调整 → settled", async () => {
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (1, 'ST-01', 7, 10000, 'pending_payment')");
      await client.execute("INSERT INTO agent_earnings (id, order_id, status, settlement_id, updated_at) VALUES (1, 1, 'settling', 1, ''), (2, 2, 'settling', 1, ''), (3, 3, 'pending', NULL, '')");
      await client.execute("INSERT INTO agent_earning_adjustments (id, order_id, status, settlement_id, updated_at) VALUES (1, 1, 'settling', 1, '')");
      const result = await reviewLegacySettlement(
        db,
        1,
        { action: "mark_paid", paymentMethod: "支付宝", paymentReference: "R999" },
        "2026-10-10T00:00:00Z",
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.toStatus).toBe("paid");
      expect(result.earnings).toBe(2);
      expect(result.adjustments).toBe(1);
      const { rows: slips } = await client.execute("SELECT * FROM agent_settlements WHERE id = 1");
      expect(slips[0]?.status).toBe("paid");
      expect(slips[0]?.payment_method).toBe("支付宝");
      expect(slips[0]?.payment_reference).toBe("R999");
      expect(slips[0]?.paid_at).toBe("2026-10-10T00:00:00Z");
      const { rows: earnings } = await client.execute("SELECT id, status FROM agent_earnings ORDER BY id");
      expect(earnings.map((e) => ({ id: Number(e.id), status: e.status }))).toEqual([
        { id: 1, status: "settled" },
        { id: 2, status: "settled" },
        { id: 3, status: "pending" },
      ]);
      const { rows: adjustments } = await client.execute("SELECT id, status FROM agent_earning_adjustments ORDER BY id");
      expect(adjustments[0]?.status).toBe("settled");
    });

    it("cancel: pending_payment → cancelled，并把 settling 收益/调整 → pending 并清 settlementId", async () => {
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (1, 'ST-01', 7, 10000, 'pending_payment')");
      await client.execute("INSERT INTO agent_earnings (id, order_id, status, settlement_id, updated_at) VALUES (1, 1, 'settling', 1, ''), (2, 2, 'settling', 1, '')");
      await client.execute("INSERT INTO agent_earning_adjustments (id, order_id, status, settlement_id, updated_at) VALUES (1, 1, 'settling', 1, '')");
      const result = await reviewLegacySettlement(db, 1, { action: "cancel" }, "2026-10-10T00:00:00Z");
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.toStatus).toBe("cancelled");
      expect(result.earnings).toBe(2);
      expect(result.adjustments).toBe(1);
      const { rows: slips } = await client.execute("SELECT status FROM agent_settlements WHERE id = 1");
      expect(slips[0]?.status).toBe("cancelled");
      const { rows: earnings } = await client.execute("SELECT id, status, settlement_id FROM agent_earnings ORDER BY id");
      expect(earnings.map((e) => ({ id: Number(e.id), status: e.status, settlementId: e.settlement_id }))).toEqual([
        { id: 1, status: "pending", settlementId: null },
        { id: 2, status: "pending", settlementId: null },
      ]);
      const { rows: adjustments } = await client.execute("SELECT status, settlement_id FROM agent_earning_adjustments WHERE id = 1");
      expect(adjustments[0]?.status).toBe("pending");
      expect(adjustments[0]?.settlement_id).toBe(null);
    });

    it("cancel: draft → cancelled，同样退回 settling 收益（draft 占用的收益也是 settling）", async () => {
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (1, 'ST-01', 7, 10000, 'draft')");
      await client.execute("INSERT INTO agent_earnings (id, order_id, status, settlement_id, updated_at) VALUES (1, 1, 'settling', 1, '')");
      const result = await reviewLegacySettlement(db, 1, { action: "cancel" }, "2026-10-10T00:00:00Z");
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.toStatus).toBe("cancelled");
      expect(result.earnings).toBe(1);
      const { rows: slips } = await client.execute("SELECT status FROM agent_settlements WHERE id = 1");
      expect(slips[0]?.status).toBe("cancelled");
      const { rows: earnings } = await client.execute("SELECT status, settlement_id FROM agent_earnings WHERE id = 1");
      expect(earnings[0]?.status).toBe("pending");
      expect(earnings[0]?.settlement_id).toBe(null);
    });
  });

  describe("路由关联", () => {
    it("路由常量与 reviewLegacySettlement outcome 对应", async () => {
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (1, 'RC-AAA', 7, 10000, 'paid')");
      await client.execute("INSERT INTO agent_reconciliation_batches (id, batch_no) VALUES (1, 'RC-AAA')");
      const mirror = await reviewLegacySettlement(db, 1, { action: "cancel" }, "2026-01-01T00:00:00Z");
      expect(mirror.kind).toBe("mirror");
      expect(MIRROR_MESSAGE).toContain("对账");
      await client.execute("INSERT INTO agent_settlements (id, settlement_no, agent_id, amount_cents, status) VALUES (2, 'ST-02', 7, 10000, 'paid')");
      const bad = await reviewLegacySettlement(db, 2, { action: "cancel" }, "2026-01-01T00:00:00Z");
      expect(bad.kind).toBe("bad_state");
      expect(BAD_STATE_MESSAGE).toContain("状态");
      expect(STATE_CHANGED_MESSAGE).toContain("刷新");
    });
  });
});
