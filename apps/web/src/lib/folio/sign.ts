import crypto from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { folioNonces } from "@/db/schema";
import { getSettings } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { sanitizeLog } from "@/lib/log";
import {
  FOLIO_BASE_URL_SETTING,
  FOLIO_ENABLED_SETTING,
  FOLIO_NONCE_TTL_MS,
  FOLIO_SECRET_SETTING,
  checkFolioSignature,
  folioSign,
  parseFolioEnvelope,
  type FolioEnvelope,
} from "@/lib/folio/core";

export { folioSign } from "@/lib/folio/core";

const FETCH_MS = 15_000;

export type FolioConfig = { enabled: boolean; baseUrl: string; secret: string };

export async function readFolioConfig(): Promise<FolioConfig> {
  const values = await getSettings([FOLIO_ENABLED_SETTING, FOLIO_BASE_URL_SETTING, FOLIO_SECRET_SETTING]);
  let secret = "";
  const raw = (values.get(FOLIO_SECRET_SETTING) || "").trim();
  if (raw) {
    try {
      secret = decryptSecret(raw).trim();
    } catch (error) {
      console.warn("[kaimi-folio] secret decrypt failed", sanitizeLog(error));
    }
  }
  return {
    enabled: values.get(FOLIO_ENABLED_SETTING) === "1",
    baseUrl: (values.get(FOLIO_BASE_URL_SETTING) || "").trim().replace(/\/+$/, ""),
    secret,
  };
}

/** 记下 nonce；10 分钟内见过的返回 false。过期还没被清掉的行可以复用。 */
async function claimNonce(nonce: string, nowMs: number) {
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + FOLIO_NONCE_TTL_MS).toISOString();
  const rows = await db.all<{ nonce: string }>(sql`
    INSERT INTO folio_nonces (nonce, expires_at) VALUES (${nonce}, ${expiresAt})
    ON CONFLICT(nonce) DO UPDATE SET expires_at = excluded.expires_at
      WHERE folio_nonces.expires_at < ${now}
    RETURNING nonce
  `);
  return rows.length > 0;
}

/**
 * 验 Folio 发来的请求。rawBody 必须是原始 body 字符串：先 req.text()，验过再 JSON.parse。
 * PATH 取请求自己的 pathname，Caddy 反代不改路径，和 Folio 签名用的一致。
 */
export async function verifyFolioRequest(
  req: Request,
  rawBody: string,
  nowMs = Date.now(),
): Promise<{ ok: true } | { ok: false; status: 401 | 503; error: string }> {
  const config = await readFolioConfig();
  if (!config.enabled || !config.secret) {
    return { ok: false, status: 503, error: "Folio 对接未开启" };
  }
  const nonce = (req.headers.get("x-folio-nonce") || "").trim();
  const checked = checkFolioSignature({
    method: req.method,
    path: new URL(req.url).pathname,
    body: rawBody,
    secret: config.secret,
    timestamp: (req.headers.get("x-folio-timestamp") || "").trim(),
    nonce,
    signature: req.headers.get("x-folio-signature") || "",
    nowSeconds: Math.floor(nowMs / 1000),
  });
  if (!checked.ok) return { ok: false, status: 401, error: checked.error };
  if (!(await claimNonce(nonce.slice(0, 200), nowMs))) {
    return { ok: false, status: 401, error: "nonce 重复" };
  }
  return { ok: true };
}

export async function pruneFolioNonces(nowMs = Date.now()) {
  const deleted = await db
    .delete(folioNonces)
    .where(lt(folioNonces.expiresAt, new Date(nowMs).toISOString()))
    .returning({ nonce: folioNonces.nonce });
  return deleted.length;
}

/** 给 Folio 发一个签过名的请求。网络错误、超时直接抛出，交给调用方决定要不要重试。 */
export async function folioFetch(
  config: FolioConfig,
  method: "POST",
  path: string,
  body: unknown,
): Promise<{ httpStatus: number; envelope: FolioEnvelope | null }> {
  if (!config.baseUrl || !config.secret) throw new Error("Folio 地址或密钥没配置");
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Folio-Timestamp": ts,
      "X-Folio-Nonce": nonce,
      "X-Folio-Signature": folioSign(method, path, ts, nonce, raw, config.secret),
    },
    body: raw,
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const text = await response.text().catch(() => "");
  return { httpStatus: response.status, envelope: parseFolioEnvelope(text) };
}
