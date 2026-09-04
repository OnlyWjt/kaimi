const SECRET_LIKE =
  /(ak_live_[a-z0-9]+|whsec_[a-z0-9]+|sk_[a-z0-9]+|Bearer\s+[^\s]+|X-API-Key['":\s]+[^\s"']+)/gi;
const CARD_LIKE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/g;

export function sanitizeLog(value: unknown) {
  return String(value ?? "")
    .replace(SECRET_LIKE, "[redacted]")
    .replace(CARD_LIKE, "[card-redacted]");
}

/**
 * `cp:<accountId>:<redemption_token>` 里的令牌就是 `GET /cdk/result` 的凭证，拿到它的人
 * 能读到这一单的账号和明细。通知发去第三方 webhook 和 Telegram，只留够对账的头尾。
 * 批量兑换一次能发二十条，一次泄漏就是二十个。
 */
export function maskRequestId(requestId: string | null | undefined) {
  const raw = (requestId || "").trim();
  const parsed = /^(cp:\d+:)(.+)$/.exec(raw);
  if (!parsed) return raw;
  const token = parsed[2]!;
  // 太短的令牌留头尾等于全给，直接整段打掉。
  if (token.length <= 12) return `${parsed[1]}***`;
  return `${parsed[1]}${token.slice(0, 4)}***${token.slice(-4)}`;
}
