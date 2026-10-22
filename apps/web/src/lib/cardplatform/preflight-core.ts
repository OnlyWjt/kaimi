/**
 * 卡台兑换预检（/api/v1/cdk/preflight）的解析和资格判断。
 *
 * 卡台预检只管「凭据能不能用、账号现在是什么套餐、各档报价多少」，不替我们判断这张卡密
 * 该不该兑给这个账号。点数要已有订阅、续费要账号就在对应档、半价要有活动资格——这些不
 * 满足时兑换必然失败，提前在预检拦下，卡密就不会被锁住再退回来。
 */

export type PreflightQuote = {
  country: string;
  currency: string;
  /** 卡台上游的套餐名（pro / prolite / promax），只做展示，判断用我们的键。 */
  upstreamPlan: string;
  amountMinor: number;
  minorUnitExponent: number;
  /** inclusive / exclusive，空串 = 卡台没给。 */
  tax: string;
};

export type PreflightPromotion = {
  kind: string;
  eligible: boolean | null;
};

export type PreflightAccount = {
  email: string;
  /** 卡台原样的 currentPlan，如 free / plus / pro / prolite / promax。 */
  currentPlanRaw: string;
  /** 换算成本站套餐键：free / go / plus / pro_5x / pro_20x / pro_50x；认不出时为空串。 */
  currentPlan: string;
  subscription: {
    active: boolean | null;
    willRenew: boolean | null;
    recoveryRequired: boolean | null;
    delinquent: boolean | null;
    purchaseOrigin: string;
    /** 当前订阅到期时间（ISO）。卡台字段名还没在付费号上核对过，几个常见名字都认；空串 = 没给。 */
    expiresAt: string;
    /** 卡台给到了时间点（true），还是只有日期（false）。只给日期时显示层不要补 00:00。 */
    expiryHasTime: boolean;
  };
  preflightToken: string;
  preflightExpiresAt: string;
  paymentCountry: string;
  paymentCurrency: string;
  /** 键是本站套餐键（plus / pro_20x…），不是 quote 里的上游套餐名。 */
  quotes: Record<string, PreflightQuote>;
  quoteError: string;
  promotions: Record<string, PreflightPromotion>;
};

export type EligibilityVerdict = "ok" | "warn" | "block";

export type PreflightEligibility = {
  verdict: EligibilityVerdict;
  /** 拦下时的原因码，和卡台直充错误码同名，调用方可以照卡台文档处理。 */
  code: string | null;
  /** 拦下的原因，给人看。 */
  reasons: string[];
  warnings: string[];
  /** 这张卡密对应套餐的报价；点数、续费档卡台不报价，为 null。 */
  quote: PreflightQuote | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function int(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 卡台 currentPlan 和本站套餐键的对照。卡台用的是 ChatGPT 自己的名字。 */
const ACCOUNT_PLAN_ALIASES: Record<string, string> = {
  free: "free",
  go: "go",
  chatgptgo: "go",
  plus: "plus",
  chatgptplusplan: "plus",
  prolite: "pro_5x",
  pro_5x: "pro_5x",
  pro: "pro_20x",
  pro_20x: "pro_20x",
  chatgptpro: "pro_20x",
  promax: "pro_50x",
  pro_50x: "pro_50x",
  chatgptpromax: "pro_50x",
};

const PLAN_LABELS: Record<string, string> = {
  free: "免费版",
  go: "Go",
  plus: "Plus",
  plus_half: "Plus 半价",
  pro_5x: "Pro 5x",
  pro_20x: "Pro 20x",
  pro_50x: "Pro 50x",
  pro_5x_renew: "Pro 5x 续费",
  pro_20x_renew: "Pro 20x 续费",
};

export function normalizeAccountPlan(raw: string) {
  return ACCOUNT_PLAN_ALIASES[raw.trim().toLowerCase()] ?? "";
}

export function accountPlanLabel(plan: string, raw = "") {
  return PLAN_LABELS[plan] || raw || plan;
}

/** 地区变体 plus:us 还是 plus 那一档。 */
export function basePlanKey(planKey: string) {
  return planKey.trim().toLowerCase().split(":")[0] ?? "";
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 卡台给的时间归一成 ISO，同时记住它给到的是时间点还是只有日期。
 * 只给日期时不要补 00:00，那是编出来的；显示层照原样给日期。
 */
export function parseExpiry(value: unknown): { iso: string; hasTime: boolean } {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return { iso: new Date(value < 1e12 ? value * 1000 : value).toISOString(), hasTime: true };
  }
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    if (DATE_ONLY.test(text)) return { iso: text, hasTime: false };
    if (/^\d+$/.test(text)) return parseExpiry(Number(text));
    const at = Date.parse(text);
    return Number.isFinite(at)
      ? { iso: new Date(at).toISOString(), hasTime: true }
      : { iso: "", hasTime: false };
  }
  return { iso: "", hasTime: false };
}

/** 秒、毫秒或 ISO 字符串统一成 ISO；认不出返回空串。 */
export function normalizeTimestamp(value: unknown) {
  return parseExpiry(value).iso;
}

// 不认裸的 expires_at：卡台的兑换会话、令牌也叫这个名字，认进来会把 15 分钟后的令牌过期当成订阅到期。
const EXPIRY_FIELDS = [
  "subscription_expires_at",
  "subscription_active_until",
  "subscription_period_end",
  "subscription_current_period_end",
  "active_until",
  "current_period_end",
];

/** 卡台响应有 { code, data } 信封，也可能被代理层拆掉，两种都认。 */
export function parsePreflight(payload: Record<string, unknown>): PreflightAccount {
  const data = payload.data && typeof payload.data === "object" ? asRecord(payload.data) : payload;
  const currentPlanRaw = str(data.currentPlan) || str(data.current_plan);
  const quotes: Record<string, PreflightQuote> = {};
  for (const [key, value] of Object.entries(asRecord(data.quotes))) {
    const row = asRecord(value);
    const amountMinor = int(row.amountMinor ?? row.amount_minor, -1);
    if (amountMinor < 0) continue;
    quotes[key.trim().toLowerCase()] = {
      country: str(row.country).toUpperCase(),
      currency: str(row.currency).toUpperCase(),
      upstreamPlan: str(row.plan),
      amountMinor,
      minorUnitExponent: int(row.minorUnitExponent ?? row.minor_unit_exponent, 2),
      tax: str(row.tax),
    };
  }
  const expiry =
    EXPIRY_FIELDS.map((key) => parseExpiry(data[key])).find((item) => item.iso) ?? {
      iso: "",
      hasTime: false,
    };
  const promotions: Record<string, PreflightPromotion> = {};
  for (const [key, value] of Object.entries(asRecord(data.promotions))) {
    const row = asRecord(value);
    promotions[key.trim().toLowerCase()] = { kind: str(row.kind), eligible: bool(row.eligible) };
  }
  return {
    email: str(data.email) || str(data.account_email),
    currentPlanRaw,
    currentPlan: normalizeAccountPlan(currentPlanRaw),
    subscription: {
      active: bool(data.subscription_has_active ?? data.has_active_subscription),
      willRenew: bool(data.subscription_will_renew),
      recoveryRequired: bool(data.subscription_recovery_required),
      delinquent: bool(data.subscription_is_delinquent),
      purchaseOrigin: str(data.subscription_purchase_origin),
      expiresAt: expiry.iso,
      expiryHasTime: expiry.hasTime,
    },
    preflightToken: str(data.preflight_token),
    preflightExpiresAt: str(data.preflight_expires_at),
    paymentCountry: str(data.payment_country).toUpperCase(),
    paymentCurrency: str(data.payment_currency).toUpperCase(),
    quotes,
    quoteError: str(data.quote_error),
    promotions,
  };
}

/** 98214 + 2 位 → "982.14"。JPY / CLP 是 0 位，不能固定除以 100。 */
export function formatMinorAmount(amountMinor: number, exponent: number) {
  const digits = Math.max(0, Math.min(4, exponent));
  if (digits === 0) return String(amountMinor);
  const sign = amountMinor < 0 ? "-" : "";
  const text = String(Math.abs(amountMinor)).padStart(digits + 1, "0");
  return `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

const SUBSCRIPTION_PLANS = new Set(["go", "plus", "plus_half", "pro_5x", "pro_20x", "pro_50x"]);
const RENEW_TARGETS: Record<string, string> = {
  pro_20x_renew: "pro_20x",
  pro_5x_renew: "pro_5x",
};

/** 应用商店买的订阅，网页端改不了也付不了。 */
const APP_STORE_ORIGIN = /apple|ios|google|android|play_?store|app_?store/i;

/**
 * 这个账号能不能兑这一档。只拦卡台文档里写明「必然失败」的情况，拿不准的一律给提示放行，
 * 最终由卡台兑换结果说了算。
 */
export function assessEligibility(account: PreflightAccount, planKey: string): PreflightEligibility {
  const base = basePlanKey(planKey);
  const reasons: string[] = [];
  const warnings: string[] = [];
  let code: string | null = null;
  const block = (reasonCode: string, message: string) => {
    code ??= reasonCode;
    reasons.push(message);
  };

  const current = account.currentPlan;
  const currentLabel = accountPlanLabel(current, account.currentPlanRaw);
  // 卡台没给 subscription_has_active 时，按套餐名推：认得出的付费档就算有订阅。
  const active =
    account.subscription.active ?? (current ? current !== "free" : null);
  const targetLabel = accountPlanLabel(base, base);
  // 半价档卡台不单独报价，账号层面和 Plus 是同一档。
  const sameTier = base === "plus_half" ? "plus" : base;

  if (/^credit\d+$/.test(base)) {
    if (active === false) {
      block(
        "GPT_CREDIT_REQUIRES_SUBSCRIPTION",
        `Codex 点数要求账号已有生效中的 Plus / Pro 订阅，当前账号是${currentLabel || "免费版"}。`,
      );
    } else if (active === null) {
      warnings.push("没能确认账号是否有生效中的订阅；点数需要已有 Plus / Pro 才能兑换。");
    }
  } else if (RENEW_TARGETS[base]) {
    const need = RENEW_TARGETS[base];
    const needLabel = accountPlanLabel(need);
    if (current && current !== need) {
      block("GPT_RENEW_TARGET_NOT_PRO", `${targetLabel}要求账号当前就在 ${needLabel}，这个账号是${currentLabel}。`);
    } else if (current === need && active === false) {
      block(
        "GPT_RENEW_SUBSCRIPTION_EXPIRED",
        `这个账号的 ${needLabel} 已经到期，续费档只能给仍在有效期内的账号绑卡，请改买新开档。`,
      );
    } else if (!current) {
      warnings.push(`没能确认账号当前套餐；${targetLabel}要求账号当前就在 ${needLabel}。`);
    }
  } else if (SUBSCRIPTION_PLANS.has(base)) {
    if (active === true && current === sameTier) {
      block("GPT_PLAN_ALREADY_ACTIVE", `账号的 ${currentLabel} 还在有效期内，不能重复开通。`);
    } else if (active === true && current && current !== "free") {
      warnings.push(`账号当前已有 ${currentLabel} 订阅，兑换 ${targetLabel} 可能失败；建议换一个没有订阅的账号，或等当前订阅到期后再兑换。`);
    }
    if (base === "plus_half") {
      const promo = account.promotions.plus_half;
      if (promo?.eligible === false) {
        block("PROMOTION_NOT_ELIGIBLE", "这个账号不符合 Plus 半价活动资格，请换一个账号或改兑 Plus。");
      } else if (!promo) {
        warnings.push("卡台没有返回这个账号的半价资格，兑换时可能被拒。");
      }
    }
    if (account.subscription.delinquent === true) {
      warnings.push("账号有未结清的账单，付款可能失败。");
    }
    if (account.subscription.recoveryRequired === true) {
      warnings.push("账号订阅处于待恢复状态，付款可能失败。");
    }
    if (active === true && APP_STORE_ORIGIN.test(account.subscription.purchaseOrigin)) {
      warnings.push("账号当前订阅是在应用商店购买的，网页端无法改动，兑换可能失败。");
    }
  }

  const quote = account.quotes[base] ?? null;
  if (SUBSCRIPTION_PLANS.has(base) && account.quoteError) {
    if (account.quotes[sameTier]) warnings.push(`卡台报价提示：${account.quoteError}`);
    else block("GPT_PRICE_UNCONFIRMED", `卡台暂时拿不到这一档的报价：${account.quoteError}`);
  }

  return {
    verdict: reasons.length ? "block" : warnings.length ? "warn" : "ok",
    code,
    reasons,
    warnings,
    quote,
  };
}

/** 卡台预检失败时的原因码。和卡台一致，不再统一成 CARDPLATFORM_ERROR。 */
const PREFLIGHT_ERROR_MESSAGES: Record<string, string> = {
  GPT_SESSION_INVALID: "Session 无效或已过期，请重新打开 chatgpt.com/api/auth/session 复制整页内容。",
  SESSION_REQUIRED: "请粘贴 ChatGPT Session。",
  GPT_PREFLIGHT_RATE_LIMITED: "预检太频繁，请一分钟后再试。",
  REDEMPTION_SESSION_INVALID: "兑换会话已过期，请重新预检。",
};

export function preflightErrorMessage(code: string, upstreamMessage: string) {
  return PREFLIGHT_ERROR_MESSAGES[code] || upstreamMessage || "卡台预检未通过";
}

/** 原样再试一次有没有可能过：只有限流和卡台暂时不可用算。换 Session、换卡密不叫重试。 */
export function preflightRetryable(code: string | null | undefined, httpStatus = 0) {
  if (code === "GPT_PREFLIGHT_RATE_LIMITED") return true;
  return [408, 429, 502, 503, 504].includes(httpStatus);
}
