import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库：迁移只跑一次、失败回滚不记版本、旧库存明文卡密被加密后还能按卡密找回来。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = join(tmpdir(), "kaimi-versioned-migrations-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));

type Modules = {
  db: typeof import("@/db").db;
  client: typeof import("@/db").client;
  orm: typeof import("drizzle-orm");
  migrations: typeof import("./versioned-migrations");
  inventory: typeof import("@/lib/inventory");
  migrateLib: typeof import("./migrate-lib");
};
let m: Modules;

beforeAll(async () => {
  const dbModule = await import("@/db");
  m = {
    db: dbModule.db,
    client: dbModule.client,
    orm: await import("drizzle-orm"),
    migrations: await import("./versioned-migrations"),
    inventory: await import("@/lib/inventory"),
    migrateLib: await import("./migrate-lib"),
  };
  await m.migrateLib.ensureSchema();
});

afterAll(async () => {
  m?.client.close();
  const { rmSync } = await import("node:fs");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行开头会删 */
    }
  }
});

async function applied() {
  const rows = await m.db.all<{ version: number }>(
    m.orm.sql`SELECT version FROM schema_migrations ORDER BY version`,
  );
  return rows.map((row) => Number(row.version));
}

describe("runVersionedMigrations", () => {
  it("启动时已经把内置迁移都记上了，再跑一次什么也不做", async () => {
    expect(await applied()).toEqual(m.migrations.MIGRATIONS.map((item) => item.version));
    expect(await m.migrations.runVersionedMigrations()).toEqual([]);
  });

  it("每条只跑一次", async () => {
    let calls = 0;
    const list = [{ version: 9001, name: "count_once", up: async () => void (calls += 1) }];
    expect(await m.migrations.runVersionedMigrations(list)).toEqual(["count_once"]);
    expect(await m.migrations.runVersionedMigrations(list)).toEqual([]);
    expect(calls).toBe(1);
  });

  it("中途失败整条回滚，不记版本，下次还会重跑", async () => {
    const list = [
      {
        version: 9002,
        name: "boom",
        up: async (tx: Parameters<(typeof m.migrations.MIGRATIONS)[number]["up"]>[0]) => {
          await tx.run(m.orm.sql`INSERT INTO settings (key, value) VALUES ('boom_probe', '1')`);
          throw new Error("boom");
        },
      },
    ];
    await expect(m.migrations.runVersionedMigrations(list)).rejects.toThrow("boom");
    expect(await applied()).not.toContain(9002);
    const probe = await m.db.all(m.orm.sql`SELECT 1 FROM settings WHERE key = 'boom_probe'`);
    expect(probe).toHaveLength(0);
  });

  it("版本号必须递增", () => {
    expect(() =>
      m.migrations.assertMigrationList([
        { version: 2, name: "a", up: async () => {} },
        { version: 2, name: "b", up: async () => {} },
      ]),
    ).toThrow();
  });
});

describe("v2 coupon_percent_to_pay_percent", () => {
  it("老写法 1–9 折乘 10，已经按百分比填的不动", async () => {
    const { sql } = m.orm;
    const agentId = 4242;
    await m.db.run(sql`INSERT INTO agent_store_coupons (agent_id, name, code, kind, percent_zhe, created_at, updated_at)
      VALUES (${agentId}, '八折', 'OLD8', 'percent', 8, 'x', 'x'), (${agentId}, '九六', 'PCT96', 'percent', 96, 'x', 'x'),
             (${agentId}, '满减', 'TH1', 'threshold', 0, 'x', 'x')`);
    await m.db.run(sql`DELETE FROM schema_migrations WHERE version = 2`);
    expect(await m.migrations.runVersionedMigrations()).toEqual(["coupon_percent_to_pay_percent"]);
    const rows = await m.db.all<{ code: string; percent_zhe: number }>(
      sql`SELECT code, percent_zhe FROM agent_store_coupons WHERE agent_id = ${agentId} ORDER BY code`,
    );
    expect(rows).toEqual([
      { code: "OLD8", percent_zhe: 80 },
      { code: "PCT96", percent_zhe: 96 },
      { code: "TH1", percent_zhe: 0 },
    ]);
  });
});

describe("v1 encrypt_legacy_pool_codes", () => {
  it("把 cdk_pool 和售码订单里的明文卡密改成密文，按卡密还能查到", async () => {
    const { sql } = m.orm;
    await m.db.run(sql`INSERT INTO cdk_pool (code, plan_key, status) VALUES (' zc-legacy-0001 ', 'plus', 'unused')`);
    await m.db.run(sql`
      INSERT INTO orders (order_no, kind, delivered_codes_json, pay_status)
      VALUES ('SC-LEGACY-1', 'code', '["ZC-LEGACY-0002"]', 'manual')
    `);
    // 模拟老库：清掉 v1 的记录再跑
    await m.db.run(sql`DELETE FROM schema_migrations WHERE version = 1`);
    expect(await m.migrations.runVersionedMigrations()).toEqual(["encrypt_legacy_pool_codes"]);

    const [pool] = await m.db.all<{ id: number; code: string; code_hash: string; code_encrypted: string }>(
      sql`SELECT id, code, code_hash, code_encrypted FROM cdk_pool`,
    );
    expect(pool.code).toBe(m.migrations.legacyPoolPlaceholder(pool.id));
    expect(pool.code_encrypted).not.toContain("LEGACY");
    expect(pool.code_hash).toHaveLength(64);

    const found = await m.inventory.findCdkByCode("zc-legacy-0001");
    expect(found?.code).toBe("zc-legacy-0001");
    expect(found?.id).toBe(pool.id);

    const [order] = await m.db.all<{ codes: string }>(
      sql`SELECT delivered_codes_json AS codes FROM orders WHERE order_no = 'SC-LEGACY-1'`,
    );
    expect(order.codes).not.toContain("ZC-LEGACY-0002");

    await m.inventory.markCodeUsed("ZC-LEGACY-0001");
    const [after] = await m.db.all<{ status: string }>(sql`SELECT status FROM cdk_pool WHERE id = ${pool.id}`);
    expect(after.status).toBe("used");
  });
});
