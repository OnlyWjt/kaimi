import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { installWriteGuard, isBusyError, isReadOnly } from "./write-guard";

const opened: Client[] = [];
const dirs: string[] = [];

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaimi-guard-"));
  dirs.push(dir);
  const url = `file:${path.join(dir, "t.db").split(path.sep).join("/")}`;
  const client = createClient({ url });
  const other = createClient({ url });
  opened.push(client, other);
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("CREATE TABLE w (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await client.execute("INSERT INTO w (id, v) VALUES (1, 0)");
  const logs: string[] = [];
  const guard = installWriteGuard(client, { waitLimitMs: 2_000, log: (m) => logs.push(m) });
  const db = drizzle(client);
  const transaction = db.transaction.bind(db);
  db.transaction = ((cb, config) => guard.runTransaction(() => transaction(cb, config))) as typeof db.transaction;
  const committed = async () => Number((await other.execute("SELECT v FROM w WHERE id = 1")).rows[0]!.v);
  return { client, other, db, logs, committed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const client of opened.splice(0)) client.close();
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上文件句柄可能还没放，留给系统清理 */
    }
  }
});

describe("installWriteGuard", () => {
  it("事务开着时，事务外的写等它结束再执行，并且真的提交了", async () => {
    const { db, committed } = await setup();
    const inTx = db.transaction(async (tx) => {
      await tx.run(sql`UPDATE w SET v = v + 10 WHERE id = 1`);
      await sleep(50);
    });
    await sleep(5);
    await db.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
    await inTx;
    expect(await committed()).toBe(11);
  });

  it("两个事务同时开，排队执行，都成功", async () => {
    const { db, committed } = await setup();
    await Promise.all(
      [1, 2, 3].map(() =>
        db.transaction(async (tx) => {
          await tx.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
          await sleep(10);
        }),
      ),
    );
    expect(await committed()).toBe(3);
  });

  it("别的连接占着锁时撞锁报错，锁放了以后主连接立刻恢复，后面的写真的提交", async () => {
    const { db, other, committed, logs } = await setup();
    const holder = await other.transaction("write");
    await holder.execute("UPDATE w SET v = 100 WHERE id = 1");
    await expect(db.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`)).rejects.toSatisfy(isBusyError);
    await holder.commit();
    // 修之前：这条会「成功」但留在没提交的隐式事务里，别的连接看不到
    await db.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
    expect(await committed()).toBe(101);
    await db.transaction(async (tx) => {
      await tx.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
    });
    expect(await committed()).toBe(102);
    expect(logs.some((line) => line.includes("重建连接"))).toBe(true);
  });

  it("事务回调里误用全局 db 写不会卡死，事务外随后照常可写", async () => {
    const { db, committed } = await setup();
    await expect(
      db.transaction(async (tx) => {
        await tx.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
        await db.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
      }),
    ).rejects.toSatisfy(isBusyError);
    await db.run(sql`UPDATE w SET v = 7 WHERE id = 1`);
    expect(await committed()).toBe(7);
  });

  it("并发混着来：40 个事务 + 40 条事务外写 + 读，全部成功、一条不丢", async () => {
    const { db, committed } = await setup();
    const jobs = Array.from({ length: 40 }, (_, i) => [
      db.transaction(async (tx) => {
        await tx.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
        await sleep(i % 3);
        await tx.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`);
      }),
      db.run(sql`UPDATE w SET v = v + 1 WHERE id = 1`),
      db.all(sql`SELECT v FROM w`),
    ]).flat();
    await Promise.all(jobs);
    expect(await committed()).toBe(120);
  });

  it("读语句不排队", () => {
    expect(isReadOnly("SELECT 1")).toBe(true);
    expect(isReadOnly({ sql: "  select * from w", args: [] })).toBe(true);
    expect(isReadOnly("PRAGMA journal_mode")).toBe(true);
    expect(isReadOnly("PRAGMA journal_mode = WAL")).toBe(false);
    expect(isReadOnly("UPDATE w SET v = 1")).toBe(false);
  });
});
