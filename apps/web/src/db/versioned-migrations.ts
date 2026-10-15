import { sql } from "drizzle-orm";
import { db } from "./index";
import { decryptSecret, encryptSecret, hashLookupValue } from "../lib/crypto";

/**
 * 只跑一次的数据迁移。
 *
 * migrate-lib.ts 的 ensureSchema 每次启动都跑：建表、补列这类 DDL 本身幂等，
 * 很便宜（现库实测 20ms 左右），也让还没合并的分支往里加列不会漏跑，所以保留。
 * 但「改数据」的迁移（回填、转换、加密存量）不该每次启动重扫全表，之前各自拿
 * settings 里的 migration_xxx_v1 标记兜着，规则不统一。新的一律写在这里：
 *
 * - version 只增不改，已经发布的条目不要再动，要修就再加一条；
 * - up 要能重复执行（中途失败会整条回滚，下次启动重跑）；
 * - 依赖的列先在 ensureSchema 里补好，这里只动数据。
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type VersionedMigration = {
  version: number;
  name: string;
  up: (tx: Tx) => Promise<void>;
};

export const MIGRATIONS: VersionedMigration[] = [
  {
    version: 1,
    name: "encrypt_legacy_pool_codes",
    up: encryptLegacyPoolCodes,
  },
  {
    version: 2,
    name: "coupon_percent_to_pay_percent",
    up: couponPercentToPayPercent,
  },
];

const CREATE_TABLE = sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

export function assertMigrationList(list: VersionedMigration[]) {
  let previous = 0;
  for (const item of list) {
    if (!Number.isInteger(item.version) || item.version <= previous) {
      throw new Error(`迁移版本号必须是递增的正整数：${item.name} = ${item.version}`);
    }
    previous = item.version;
  }
}

/** 按版本号跑还没跑过的迁移，每条连同记录写在同一个事务里。返回这次跑了哪些。 */
export async function runVersionedMigrations(list: VersionedMigration[] = MIGRATIONS) {
  assertMigrationList(list);
  await db.run(CREATE_TABLE);
  const rows = await db.all<{ version: number }>(sql`SELECT version FROM schema_migrations`);
  const done = new Set(rows.map((row) => Number(row.version)));
  const ran: string[] = [];
  for (const item of list) {
    if (done.has(item.version)) continue;
    await db.transaction(async (tx) => {
      await item.up(tx);
      await tx.run(
        sql`INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (${item.version}, ${item.name}, ${new Date().toISOString()})
            ON CONFLICT(version) DO NOTHING`,
      );
    });
    ran.push(item.name);
  }
  return ran;
}

/**
 * v1：旧内部发卡库存 cdk_pool 和售码订单 orders.delivered_codes_json 里的卡密是明文。
 * 改成和 issued_cdks 一样：密文 + HMAC 查找键；code 列只留一个不含卡密的占位值（列上有唯一约束）。
 */
async function encryptLegacyPoolCodes(tx: Tx) {
  const pool = await tx.all<{ id: number; code: string }>(
    sql`SELECT id, code FROM cdk_pool WHERE code_encrypted = ''`,
  );
  for (const row of pool) {
    const plain = row.code.trim();
    await tx.run(sql`
      UPDATE cdk_pool
      SET code_encrypted = ${encryptSecret(plain)},
          code_hash = ${hashLookupValue(plain.toUpperCase())},
          code = ${legacyPoolPlaceholder(row.id)}
      WHERE id = ${row.id}
    `);
  }

  const delivered = await tx.all<{ id: number; codes: string }>(
    sql`SELECT id, delivered_codes_json AS codes FROM orders
        WHERE delivered_codes_json NOT IN ('', '[]')`,
  );
  for (const row of delivered) {
    let codes: unknown;
    try {
      codes = JSON.parse(row.codes);
    } catch {
      continue;
    }
    if (!Array.isArray(codes)) continue;
    const sealed = codes.map((code) => encryptSecret(decryptSecret(String(code))));
    await tx.run(sql`
      UPDATE orders SET delivered_codes_json = ${JSON.stringify(sealed)} WHERE id = ${row.id}
    `);
  }
}

/**
 * v2：折扣券 percent_zhe 原来存「几折」（8 = 8 折），算价时却按 原价 × 值 ÷ 10，
 * 校验又放到 1–99：填 96 想打 9.6 折的券实际把价格乘成 9.6 倍。
 * 改成存实付百分比（80 = 8 折）。1–9 是老写法，乘 10；10 及以上在老算法下都会涨价，
 * 只可能是按百分比填的，原样保留。订单上的快照一起换算，只看折扣券那几单。
 */
async function couponPercentToPayPercent(tx: Tx) {
  await tx.run(sql`
    UPDATE agent_store_coupons SET percent_zhe = percent_zhe * 10
    WHERE kind = 'percent' AND percent_zhe BETWEEN 1 AND 9
  `);
  await tx.run(sql`
    UPDATE store_orders SET coupon_percent_snapshot = coupon_percent_snapshot * 10
    WHERE coupon_kind_snapshot = 'percent' AND coupon_percent_snapshot BETWEEN 1 AND 9
  `);
}

/** cdk_pool.code 加密后留下的占位值，按 id 保证唯一。 */
export function legacyPoolPlaceholder(id: number) {
  return `enc:${id}`;
}
