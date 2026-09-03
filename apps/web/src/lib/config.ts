import { eq, inArray } from "drizzle-orm";
import { client, db } from "@/db";
import { settings } from "@/db/schema";
import { ensureSchema } from "@/db/migrate-lib";
import { assertRuntimeSecrets } from "@/lib/crypto";
import "./network/prefer-ipv4";

let booted = false;
let bootPromise: Promise<void> | null = null;

export async function bootDb() {
  // 启动后直接返回。这里原本每次都调 ensureCardOpsTables()，而它是 9 条建表建索引语句、
  // 还要拿 SQLite 写锁；ensureSchema() 末尾已经建过一次，每个请求再重复毫无意义。
  if (booted) return;
  assertRuntimeSecrets();
  if (!bootPromise) {
    bootPromise = (async () => {
      await client.execute("PRAGMA foreign_keys = ON");
      await ensureSchema();
      booted = true;
      // Lazy import avoids circular dependency with sync-scheduler
      void import("@/lib/sync-scheduler").then((m) => m.ensureSyncScheduler());
    })().finally(() => {
      bootPromise = null;
    });
  }
  await bootPromise;
}

export async function getSetting(key: string, fallback = "") {
  await bootDb();
  const row = await db.query.settings.findFirst({
    where: eq(settings.key, key),
  });
  return row?.value ?? fallback;
}

/** 一次取多个配置项，省掉逐个 key 串行往返。 */
export async function getSettings(keys: string[]) {
  await bootDb();
  if (keys.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys));
  return new Map(rows.map((row) => [row.key, row.value]));
}

export async function setSetting(key: string, value: string) {
  await bootDb();
  const existing = await db.query.settings.findFirst({
    where: eq(settings.key, key),
  });
  if (existing) {
    await db
      .update(settings)
      .set({ value, updatedAt: new Date().toISOString() })
      .where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
}

export type AppConfig = {
  webhookSecret: string;
  setupCompleted: boolean;
  paymentMode: "manual";
};

export async function getAppConfig(): Promise<AppConfig> {
  await bootDb();
  const [webhookSecret, setupCompleted] = await Promise.all([
    getSetting("webhook_secret", process.env.KAIMI_WEBHOOK_SECRET || ""),
    getSetting("setup_completed", "0"),
  ]);

  return {
    webhookSecret,
    setupCompleted: setupCompleted === "1",
    paymentMode: "manual",
  };
}
