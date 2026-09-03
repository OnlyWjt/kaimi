export const CARD_FAIL_VERDICTS = {
  needMore: "need_more",
  emailSuspect: "email_suspect",
  cardSuspect: "card_suspect",
  unknownEmails: "unknown_emails",
  alreadyBlocked: "already_blocked",
} as const;

export type CardHealthPolicy = {
  enabled: boolean;
  failThreshold: number;
  freezeOnBlock: boolean;
  requireKnownEmail: boolean;
};

export function defaultCardHealthPolicy(): CardHealthPolicy {
  return {
    enabled: true,
    failThreshold: 2,
    freezeOnBlock: false,
    requireKnownEmail: true,
  };
}

export function evaluateCardFailVerdict(
  failCount: number,
  distinctEmails: number,
  threshold: number,
  requireKnownEmail: boolean,
) {
  const limit = threshold < 1 ? 2 : threshold;
  if (failCount < limit) return CARD_FAIL_VERDICTS.needMore;
  if (distinctEmails >= 2) return CARD_FAIL_VERDICTS.cardSuspect;
  if (distinctEmails === 1) return CARD_FAIL_VERDICTS.emailSuspect;
  return requireKnownEmail
    ? CARD_FAIL_VERDICTS.unknownEmails
    : CARD_FAIL_VERDICTS.cardSuspect;
}
