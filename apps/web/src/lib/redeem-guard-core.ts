export const REDEEM_REJECT_MESSAGE = "卡密无效或已使用";

export class RedeemRejectedError extends Error {
  readonly outcome: "unknown_code" | "used_code" | "disabled_code";

  constructor(outcome: "unknown_code" | "used_code" | "disabled_code") {
    super(REDEEM_REJECT_MESSAGE);
    this.name = "RedeemRejectedError";
    this.outcome = outcome;
  }
}

export const ANON_BATCH_CODES_PER_REQUEST = 10;
export const ANON_BATCH_CODES_PER_HOUR = 20;
export const AGENT_BATCH_CODES_PER_HOUR = 500;
export const UNKNOWN_CODE_STOP_AFTER = 3;

export type GuardOutcome =
  | "unknown_code"
  | "used_code"
  | "disabled_code"
  | "preflight_failed"
  | "blocked"
  | "ok"
  | "in_flight";

export type BlockDecision = {
  subjectType: "ip" | "email";
  subject: string;
  minutes: number;
  reason: string;
};

/** 去掉邮箱本地部分的 +tag，避免换一个加号就换一个桶。 */
export function normalizeGuardEmail(email: string) {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at).split("+")[0];
  return `${local}@${trimmed.slice(at + 1)}`;
}

/** 预检失败算半次，避免手滑的真实客户立刻被封。其它失败算一次。 */
export function failureWeight(outcome: string) {
  if (outcome === "preflight_failed") return 0.5;
  if (
    outcome === "unknown_code" ||
    outcome === "used_code" ||
    outcome === "disabled_code"
  ) {
    return 1;
  }
  return 0;
}

export function sumFailureWeight(outcomes: string[]) {
  return outcomes.reduce((sum, outcome) => sum + failureWeight(outcome), 0);
}

/**
 * 同一时刻只升最长的那一档。IP 24 小时档优先于 10 分钟档，邮箱单独一档。
 * 调用方按窗口筛好再传进来。
 */
export function decideBlock(input: {
  ip: string;
  email: string;
  ipWeight10m: number;
  ipWeight24h: number;
  emailWeight1h: number;
}): BlockDecision | null {
  if (input.ip && input.ipWeight24h >= 20) {
    return {
      subjectType: "ip",
      subject: input.ip,
      minutes: 24 * 60,
      reason: "24 小时内兑换失败达到 20 次",
    };
  }
  if (input.ip && input.ipWeight10m >= 5) {
    return {
      subjectType: "ip",
      subject: input.ip,
      minutes: 30,
      reason: "10 分钟内兑换失败达到 5 次",
    };
  }
  if (input.email && input.emailWeight1h >= 5) {
    return {
      subjectType: "email",
      subject: input.email,
      minutes: 60,
      reason: "1 小时内该邮箱兑换失败达到 5 次",
    };
  }
  return null;
}

export function retryAfterSeconds(blockedUntilIso: string, nowMs = Date.now()) {
  const until = Date.parse(blockedUntilIso);
  if (!Number.isFinite(until)) return 60;
  return Math.max(1, Math.ceil((until - nowMs) / 1000));
}
