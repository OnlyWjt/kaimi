const SECRET_LIKE =
  /(ak_live_[a-z0-9]+|whsec_[a-z0-9]+|sk_[a-z0-9]+|Bearer\s+[^\s]+|X-API-Key['":\s]+[^\s"']+)/gi;
const CARD_LIKE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/g;

export function sanitizeLog(value: unknown) {
  return String(value ?? "")
    .replace(SECRET_LIKE, "[redacted]")
    .replace(CARD_LIKE, "[card-redacted]");
}
