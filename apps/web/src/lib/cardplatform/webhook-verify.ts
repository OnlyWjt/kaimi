import crypto from "node:crypto";

const SKEW_SECONDS = 300;

export function webhookSignatureCandidates(headers: Headers) {
  const names = [
    "x-avanfinity-signature",
    "x-signature",
    "x-webhook-signature",
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
    for (const prefix of ["v1=", "sha256="]) {
      if (key.startsWith(prefix)) add(trimmed.slice(prefix.length));
    }
  };
  for (const name of names) add(headers.get(name) || "");
  return out;
}

export function webhookTimestamps(headers: Headers) {
  const names = [
    "x-avanfinity-webhook-timestamp",
    "x-webhook-timestamp",
    "x-avanfinity-timestamp",
    "x-timestamp",
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const ts = (headers.get(name) || "").trim();
    if (!ts || seen.has(ts)) continue;
    seen.add(ts);
    out.push(ts);
  }
  return out;
}

export function webhookTimestampSkewOk(ts: string, now = Date.now()) {
  let unix = Number(ts.trim());
  if (!Number.isFinite(unix)) return true;
  if (unix > 1_000_000_000_000) unix = Math.floor(unix / 1000);
  return Math.abs(Math.floor(now / 1000) - unix) <= SKEW_SECONDS;
}

function hmacHex(secret: string, message: Buffer) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function secretVariants(secret: string) {
  const trimmed = secret.trim();
  const out = [trimmed];
  if (trimmed.startsWith("whsec_")) out.push(trimmed.slice("whsec_".length));
  return out.filter(Boolean);
}

function signedMessages(raw: Buffer, timestamps: string[]) {
  const msgs: Buffer[] = [];
  if (timestamps.length === 0) msgs.push(raw);
  for (const ts of timestamps) {
    msgs.push(Buffer.concat([Buffer.from(ts, "utf8"), Buffer.from("."), raw]));
  }
  if (timestamps.length > 0) msgs.push(raw);
  return msgs;
}

export function webhookSignatureMatches(
  secret: string,
  raw: Buffer,
  timestamps: string[],
  gots: string[],
) {
  if (!secret.trim() || gots.length === 0) return false;
  const expects = secretVariants(secret).flatMap((sec) =>
    signedMessages(raw, timestamps).map((msg) => hmacHex(sec, msg)),
  );
  for (const got of gots) {
    let value = got.trim().toLowerCase();
    for (const prefix of ["v1=", "sha256="]) {
      if (value.startsWith(prefix)) value = value.slice(prefix.length);
    }
    const gotBuf = Buffer.from(value, "utf8");
    for (const expect of expects) {
      const expectBuf = Buffer.from(expect.toLowerCase(), "utf8");
      if (gotBuf.length !== expectBuf.length) continue;
      if (crypto.timingSafeEqual(gotBuf, expectBuf)) return true;
    }
  }
  return false;
}
