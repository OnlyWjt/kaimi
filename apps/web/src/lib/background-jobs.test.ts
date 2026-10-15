import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真库：只删 30 天前已完成的任务，失败的和最近的都留着。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = join(tmpdir(), "kaimi-background-jobs-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));

let jobs: typeof import("./background-jobs");
let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");

beforeAll(async () => {
  await (await import("./config")).bootDb();
  jobs = await import("./background-jobs");
  db = (await import("@/db")).db;
  schema = await import("@/db/schema");
});

afterAll(async () => {
  (await import("@/db")).client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行开头会删 */
    }
  }
});

describe("pruneCompletedJobs", () => {
  it("只删超过保留期的已完成任务", async () => {
    const now = Date.parse("2026-10-15T00:00:00Z");
    const old = new Date(now - jobs.COMPLETED_JOB_RETENTION_MS - 60_000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    const row = (key: string, status: string, updatedAt: string) => ({
      type: "fulfill_store_order",
      dedupeKey: key,
      payloadJson: "{}",
      status,
      runAfter: updatedAt,
      createdAt: updatedAt,
      updatedAt,
    });
    await db.insert(schema.backgroundJobs).values([
      row("old-done", "completed", old),
      row("old-failed", "failed", old),
      row("new-done", "completed", recent),
    ]);

    expect(await jobs.pruneCompletedJobs(now)).toBe(1);
    const left = await db.select({ key: schema.backgroundJobs.dedupeKey }).from(schema.backgroundJobs);
    expect(left.map((item) => item.key).sort()).toEqual(["new-done", "old-failed"]);
  });
});
