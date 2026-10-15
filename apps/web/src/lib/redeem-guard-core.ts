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

/**
 * 预检失败算半次，避免手滑的真实客户立刻被封。猜码（不存在 / 已禁用）算一次。
 * 已使用的卡不算：卡是真的，多半是买家兑换完又粘了一次，或批量里混进了用过的；撞库猜不出真卡。
 */
export function failureWeight(outcome: string) {
  if (outcome === "preflight_failed") return 0.5;
  if (outcome === "unknown_code" || outcome === "disabled_code") return 1;
  return 0;
}

/** 批量里遇到几张这种就停掉整批。已使用的卡不算猜码，不让它把整批卡住。 */
export function isGuessOutcome(outcome: string) {
  return failureWeight(outcome) >= 1;
}

/**
 * 批量校验、批量提交逐张走的时候用：猜码累计到 UNKNOWN_CODE_STOP_AFTER 张，后面的不再查。
 * 两处共用这一份，免得一边改了规则另一边没改。
 */
export function createBatchGuessGuard(stopAfter = UNKNOWN_CODE_STOP_AFTER) {
  let guesses = 0;
  return {
    get stopped() {
      return guesses >= stopAfter;
    },
    reject(outcome: string) {
      if (isGuessOutcome(outcome)) guesses += 1;
    },
  };
}

export const BATCH_STOPPED_MESSAGE = "连续多张卡密无效，已停止本批";

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
