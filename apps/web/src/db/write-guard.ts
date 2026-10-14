import { AsyncLocalStorage } from "node:async_hooks";
import type { Client, InStatement, TransactionMode } from "@libsql/client";

/**
 * 本地 SQLite 的写保护，解决线上「一段时间内所有写都报 Failed query / SQLITE_BUSY_SNAPSHOT」。
 *
 * 两个坑叠在一起：
 * 1. @libsql/client 开事务时把主连接交给事务、再给后续查询新开一个连接，新连接 busy_timeout 是 0。
 *    事务没提交时，事务外的任何写都会立刻 SQLITE_BUSY。busy_timeout 救不了：持锁的事务和等锁的写
 *    在同一个 JS 线程里，native 层同步睡眠时事务永远提交不了。
 * 2. 撞锁失败的那条语句不会被 reset，主连接因此挂着一个隐式事务，直到 GC 回收那条语句：
 *    这期间主连接上的写要么报 SQLITE_BUSY_SNAPSHOT，要么「看起来成功、其实没提交」，之后被丢掉。
 *
 * 所以：
 * - 写事务在进程内排队，一个接一个开；事务开着时，事务外的写先等它结束。读不排队（WAL 下读不受影响）。
 * - 万一还是撞了锁（别的进程、事务回调里误用全局 db 写），丢掉主连接重建，再重试一次，不让连接带病继续用。
 */

type Runner = <T>(fn: () => Promise<T>) => Promise<T>;

export type WriteGuard = {
  /** 包住 drizzle 的 db.transaction：排队、标记「在事务里」。 */
  runTransaction: Runner;
};

export function installWriteGuard(
  client: Client,
  options: { waitLimitMs?: number; log?: (message: string) => void } = {},
): WriteGuard {
  const waitLimitMs = options.waitLimitMs ?? 15_000;
  const log = options.log ?? ((message: string) => console.warn(message));
  const inTransaction = new AsyncLocalStorage<boolean>();
  /** 最后一个排队事务结束时 resolve。 */
  let tail: Promise<void> = Promise.resolve();

  async function waitFor(previous: Promise<void>, what: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      previous.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), waitLimitMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      // 有事务卡了这么久，多半是事务里在等网络。不再死等：照常执行，撞锁会走下面的重建连接。
      log(`[db-write-guard] 等写事务超过 ${waitLimitMs}ms，直接执行 ${what}`);
    }
  }

  /** 撞锁后主连接已经坏了：重建，再试一次。 */
  async function withBusyRecovery<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      log(`[db-write-guard] ${what} 撞锁（${busyCode(error)}），重建连接后重试`);
      await client.reconnect();
      try {
        return await run();
      } catch (retryError) {
        // 重试也撞锁：再重建一次再报错，别把坏连接留给下一个请求。
        if (isBusyError(retryError)) await client.reconnect();
        throw retryError;
      }
    }
  }

  const originalExecute = client.execute.bind(client) as (...args: unknown[]) => ReturnType<Client["execute"]>;
  const originalBatch = client.batch.bind(client);
  const originalExecuteMultiple = client.executeMultiple.bind(client);
  const originalTransaction = client.transaction.bind(client);

  client.execute = (async (...args: unknown[]) => {
    const stmt = args[0] as InStatement;
    // 事务回调里用全局 db 写：等事务结束就是死锁，直接执行（会撞锁报错，但不会卡死）。
    if (!inTransaction.getStore() && !isReadOnly(stmt)) await waitFor(tail, "write");
    return withBusyRecovery("execute", () => originalExecute(...args));
  }) as Client["execute"];

  client.batch = (async (...args: Parameters<Client["batch"]>) => {
    if (!inTransaction.getStore()) await waitFor(tail, "batch");
    return withBusyRecovery("batch", () => originalBatch(...args));
  }) as Client["batch"];

  client.executeMultiple = async (sql: string) => {
    if (!inTransaction.getStore()) await waitFor(tail, "executeMultiple");
    return withBusyRecovery("executeMultiple", () => originalExecuteMultiple(sql));
  };

  // 开事务的 BEGIN 撞锁也会把主连接弄坏，一样重建重试。
  client.transaction = (mode?: TransactionMode) =>
    withBusyRecovery("transaction", () => originalTransaction(mode));

  const runTransaction: Runner = async (fn) => {
    // 嵌套（事务回调里又调全局 db.transaction）不排队，否则自己等自己。
    if (inTransaction.getStore()) return fn();
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = previous.then(() => finished);
    await waitFor(previous, "transaction");
    try {
      return await inTransaction.run(true, fn);
    } finally {
      release();
    }
  };

  return { runTransaction };
}

export function isReadOnly(stmt: InStatement) {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  return /^\s*(select|explain)\b/i.test(sql) || /^\s*pragma\s+[\w.]+\s*;?\s*$/i.test(sql);
}

function busyCode(error: unknown) {
  const own = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof own === "string" ? own : typeof cause === "string" ? cause : "";
}

export function isBusyError(error: unknown) {
  return busyCode(error).startsWith("SQLITE_BUSY") || /database is locked/i.test(String((error as Error)?.message));
}
