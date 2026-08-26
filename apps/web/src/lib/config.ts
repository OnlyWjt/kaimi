import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { ensureSchema } from "@/db/migrate-lib";

let booted = false;
let bootPromise: Promise<void> | null = null;

export async function bootDb() {
  if (booted) return;
  if (!bootPromise) {
    bootPromise = (async () => {
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
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  webhookSecret: string;
  setupCompleted: boolean;
  paymentMode: "manual";
};

export async function getAppConfig(): Promise<AppConfig> {
  await bootDb();
  const [
    upstreamBaseUrl,
    upstreamApiKey,
    webhookSecret,
    setupCompleted,
    paymentMode,
  ] = await Promise.all([
    getSetting("upstream_base_url", process.env.KAIMI_UPSTREAM_BASE_URL || ""),
    getSetting("upstream_api_key", process.env.KAIMI_UPSTREAM_API_KEY || ""),
    getSetting("webhook_secret", process.env.KAIMI_WEBHOOK_SECRET || ""),
    getSetting("setup_completed", "0"),
    getSetting("payment_mode", "manual"),
  ]);

  return {
    upstreamBaseUrl,
    upstreamApiKey,
    webhookSecret,
    setupCompleted: setupCompleted === "1",
    paymentMode: "manual",
  };
}
