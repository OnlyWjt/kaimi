import crypto from "node:crypto";

const ENC_V1_PREFIX = "enc:v1:";
const ENC_V2_PREFIX = "enc:v2:";
const DEVELOPMENT_SECRET = "kaimi-dev-secret-change-me";
const EXAMPLE_SECRET = "please-change-this-long-random-string";

function secretMaterial() {
  const configured = process.env.KAIMI_SECRET_KEY || "";
  if (
    process.env.NODE_ENV === "production" &&
    (!configured ||
      configured === DEVELOPMENT_SECRET ||
      configured === EXAMPLE_SECRET ||
      configured === process.env.CARD_API_KEY ||
      configured === process.env.KAIMI_CARDPLATFORM_API_KEY ||
      Buffer.byteLength(configured, "utf8") < 32)
  ) {
    throw new Error(
      "生产环境必须配置至少 32 字节的独立 KAIMI_SECRET_KEY，禁止复用卡台 API Key",
    );
  }
  return configured || DEVELOPMENT_SECRET;
}

export function assertRuntimeSecrets() {
  void secretMaterial();
}

export function deriveSecretBytes(purpose: string) {
  return crypto
    .createHmac("sha256", secretMaterial())
    .update(`kaimi:${purpose}:v1`, "utf8")
    .digest();
}

function masterKey(): Buffer {
  const raw = secretMaterial();
  return crypto.createHash("sha256").update(raw).digest();
}

function keyId() {
  return crypto.createHash("sha256").update(masterKey()).digest("hex").slice(0, 12);
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(ENC_V1_PREFIX) || plain.startsWith(ENC_V2_PREFIX)) {
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_V2_PREFIX}${keyId()}:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(value: string): string {
  if (!value) return "";
  if (
    !value.startsWith(ENC_V1_PREFIX) &&
    !value.startsWith(ENC_V2_PREFIX)
  ) {
    return value;
  }
  const isV2 = value.startsWith(ENC_V2_PREFIX);
  const body = value.slice(
    isV2 ? ENC_V2_PREFIX.length : ENC_V1_PREFIX.length,
  );
  const parts = body.split(":");
  if (isV2) {
    const encryptedKeyId = parts.shift();
    if (encryptedKeyId !== keyId()) {
      throw new Error(
        `加密数据密钥不匹配（数据 ${encryptedKeyId || "unknown"}，当前 ${keyId()}）`,
      );
    }
  }
  const [ivHex, tagHex, dataHex] = parts;
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

export function hashLookupValue(value: string) {
  return crypto
    .createHmac("sha256", masterKey())
    .update(value.trim(), "utf8")
    .digest("hex");
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
