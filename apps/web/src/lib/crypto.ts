import crypto from "node:crypto";

const ENC_PREFIX = "enc:v1:";

function masterKey(): Buffer {
  const raw =
    process.env.KAIMI_SECRET_KEY ||
    process.env.KAIMI_UPSTREAM_API_KEY ||
    "kaimi-dev-secret-change-me";
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(ENC_PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(value: string): string {
  if (!value) return "";
  if (!value.startsWith(ENC_PREFIX)) return value;
  const body = value.slice(ENC_PREFIX.length);
  const [ivHex, tagHex, dataHex] = body.split(":");
  if (!ivHex || !tagHex || !dataHex) return "";
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export function verifyWebhookSignature(opts: {
  secret: string;
  timestamp: string;
  rawBody: string | Buffer;
  signature: string;
  maxSkewSeconds?: number;
}): { ok: boolean; reason?: string } {
  const { secret, timestamp, rawBody, signature, maxSkewSeconds = 300 } = opts;
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > maxSkewSeconds) return { ok: false, reason: "timestamp_skew" };

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expect = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(String(timestamp), "utf8"), Buffer.from(".", "utf8"), bodyBuf]))
    .digest("hex");

  const got = signature.trim().toLowerCase().replace(/^sha256=/, "");
  const a = Buffer.from(expect, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "bad_signature" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

export function maskCode(code: string) {
  if (code.length <= 8) return "****";
  return `${code.slice(0, 4)}****${code.slice(-4)}`;
}

export function centsToYuan(cents: number) {
  return (cents / 100).toFixed(2);
}

export function yuanToCents(yuan: number) {
  return Math.round(yuan * 100);
}
