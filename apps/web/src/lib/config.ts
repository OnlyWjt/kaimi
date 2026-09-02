import { eq } from "drizzle-orm";
import { client, db } from "@/db";
import { settings } from "@/db/schema";
import { ensureCardOpsTables, ensureSchema } from "@/db/migrate-lib";
import { assertRuntimeSecrets } from "@/lib/crypto";
import "./network/prefer-ipv4";

let booted = false;
let bootPromise: Promise<void> | null = null;

export async function bootDb() {
  if (booted) {
    await ensureCardOpsTables();
    return;
  }
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
