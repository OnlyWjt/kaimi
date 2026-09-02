import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts, issuedCdks, webhookEvents } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { observeFromWebhookPayload } from "./health";
import {
  defaultAccountWebhookPath,
  webhookPathForSlug,
} from "./urls";
import {
  webhookSignatureCandidates,
  webhookSignatureMatches,
  webhookTimestamps,
  webhookTimestampSkewOk,
} from "./webhook-verify";

export {
  webhookSignatureCandidates,
  webhookSignatureMatches,
  webhookTimestamps,
  webhookTimestampSkewOk,
} from "./webhook-verify";

function webhookIdemKey(payload: Record<string, unknown>, eventType: string) {
  const str = (key: string) => {
    const value = payload[key];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return "";
  };
  if (eventType === "card_transaction") {
    return [eventType, str("auth_id"), str("type"), str("status")].join("|");
  }
  if (eventType === "card_operation") {
    return [eventType, str("operation"), str("operation_id"), str("status")].join(
      "|",
    );
  }
  if (eventType === "gpt_direct.completed") {
    if (str("order_id")) return `gpt_direct.completed|order|${str("order_id")}`;
    if (str("client_request_id")) {
      return `gpt_direct.completed|client|${str("client_request_id")}`;
    }
  }
  return crypto
    .createHash("sha256")
    .update(
      `${str("auth_id")}${str("order_id")}${str("operation_id")}${eventType}${Date.now()}`,
    )
    .digest("hex")
    .slice(0, 32);
}

async function resolveWebhookAccount(slug?: string) {
  if (!slug) return 0;
  const path = webhookPathForSlug(slug);
  const accounts = await db.query.cardplatformAccounts.findMany();
  for (const account of accounts) {
    const stored =
      account.webhookPath.trim().replace(/\/+$/, "") ||
      defaultAccountWebhookPath(account.id);
    if (stored === path) return account.id;
  }
  const numeric = Number(slug);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  return -1;
}

async function applyIssuedStatusFromWebhook(
  payload: Record<string, unknown>,
  eventType: string,
  accountId: number,
) {
  const cdkId = Number(payload.cdk_id || 0);
  if (!Number.isSafeInteger(cdkId) || cdkId <= 0) return;
  const et = eventType.toLowerCase();
  let status = String(payload.cdk_status || "").trim().toLowerCase();
  if (!status && et.includes("completed")) status = "consumed";
  if (!status) return;
  const mapped =
    status === "consumed" || status === "used"
      ? "used"
      : status === "disabled"
        ? "disabled"
        : status === "unused"
          ? "unused"
          : "";
  if (!mapped) return;
  const row = await db.query.issuedCdks.findFirst({
    where: and(
      eq(issuedCdks.upstreamRef, String(cdkId)),
      eq(issuedCdks.cardplatformAccountId, accountId),
    ),
  });
  if (!row) return;
  if (
    mapped === "unused" &&
    (row.status === "used" || row.status === "disabled")
  ) {
    return;
  }
  await db
    .update(issuedCdks)
    .set({
      status: mapped,
      usedAt: mapped === "used" ? new Date().toISOString() : row.usedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(issuedCdks.id, row.id));
}

export function sanitizeWebhookPayload(raw: string) {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.card_number === "string" && parsed.card_number.length > 4) {
      parsed.card_number = `****${parsed.card_number.slice(-4)}`;
    }
    return parsed;
  } catch {
    return {};
  }
}

export async function ingestCardplatformWebhook(input: {
  raw: string;
  headers: Headers;
  slug?: string;
}) {
  const wantAccountId = await resolveWebhookAccount(input.slug);
  if (wantAccountId < 0) return { status: 404 as const };
  const accounts = await db.query.cardplatformAccounts.findMany();
  const credentials = accounts
    .filter((account) => wantAccountId <= 0 || account.id === wantAccountId)
    .map((account) => ({
      accountId: account.id,
      secret: decryptSecret(account.webhookSecretEncrypted),
    }))
    .filter((item) => item.secret);
  if (credentials.length === 0) return { status: 503 as const };

  const rawBuf = Buffer.from(input.raw, "utf8");
  const gots = webhookSignatureCandidates(input.headers);
  if (gots.length === 0) return { status: 401 as const };
  const timestamps = webhookTimestamps(input.headers);
  const avanfinityTs = (input.headers.get("x-avanfinity-webhook-timestamp") || "").trim();
  if (avanfinityTs && !webhookTimestampSkewOk(avanfinityTs)) {
    return { status: 401 as const };
  }

  let matchedAccountId = 0;
  for (const credential of credentials) {
    if (webhookSignatureMatches(credential.secret, rawBuf, timestamps, gots)) {
      matchedAccountId = credential.accountId;
      break;
    }
  }
  if (!matchedAccountId) return { status: 401 as const };

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(input.raw) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const eventType = String(payload.event || payload.type || "").trim();
  const avanfinityId = (input.headers.get("x-avanfinity-webhook-id") || "").trim();
  const eventId = avanfinityId
    ? `avanfinity|${avanfinityId}`
    : webhookIdemKey(payload, eventType);
  try {
    await db.insert(webhookEvents).values({
      accountId: matchedAccountId,
      eventId,
      eventType,
      payloadJson: input.raw,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/UNIQUE|unique/i.test(message)) throw error;
  }
  if (eventType.toLowerCase().startsWith("gpt_direct.")) {
    await applyIssuedStatusFromWebhook(payload, eventType, matchedAccountId);
    await observeFromWebhookPayload(payload, matchedAccountId);
  }
  return { status: 200 as const };
}
