import { asc } from "drizzle-orm";
import { db } from "@/db";
import { paymentChannelConfigs } from "@/db/schema";
import { getSetting } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import type { PaymentChannel } from "./fees";
import type { EpayConfig, EpaySignMode } from "./epay";

export async function getEpayConfig(): Promise<EpayConfig> {
  const [apiBase, pid, encryptedKey, signMode] = await Promise.all([
    getSetting("epay_api_base", ""),
    getSetting("epay_pid", ""),
    getSetting("epay_key", ""),
    getSetting("epay_sign_mode", "append"),
  ]);
  return {
    apiBase: apiBase.trim().replace(/\/+$/, ""),
    pid: pid.trim(),
    key: decryptSecret(encryptedKey),
    signMode: signMode === "key_param" ? "key_param" : "append",
  };
}

export function epayReady(config: EpayConfig) {
  return Boolean(config.apiBase && config.pid && config.key);
}

export async function getPaymentChannelRules() {
  const rows = await db.query.paymentChannelConfigs.findMany({
    orderBy: [asc(paymentChannelConfigs.id)],
  });
  return rows.filter(
    (row): row is typeof row & { channel: PaymentChannel } =>
      row.channel === "alipay" || row.channel === "wxpay",
  );
}

export function normalizeSignMode(value: string): EpaySignMode {
  return value === "key_param" ? "key_param" : "append";
}
