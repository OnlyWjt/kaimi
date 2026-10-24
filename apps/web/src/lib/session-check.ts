import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformPlans } from "@/db/schema";
import { preflightRedeemableCdk } from "@/lib/cardplatform/redeem";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";
import {
  CARD_PRODUCTS,
  grokCredential,
  isCardProduct,
  productOfPlanKey,
  xCredential,
  xCredentialEmail,
  type CardProduct,
} from "@/lib/cardplatform/product";
import { CardplatformError } from "@/lib/cardplatform/client";
import {
  accountPlanLabel,
  assessEligibility,
  preflightRetryable,
  type PreflightAccount,
  type PreflightEligibility,
} from "@/lib/cardplatform/preflight-core";

export type SessionSummary = {
  email?: string;
  plan_type?: string;
  has_active_subscription?: boolean;
  expires_at?: string;
  /** 卡台只给到日期时传 false，显示层不要补时间。 */
  expires_at_has_time?: boolean;
  account_id?: string;
  [key: string]: unknown;
};

export type SessionCheckResult = {
  ok: boolean;
  email?: string;
  name?: string;
  hasAccessToken: boolean;
  planHint?: string;
  summary?: SessionSummary;
  errorCode?: string;
  /** 卡台返回的 HTTP 状态；429 时上层要原样回 429。 */
  httpStatus?: number;
  /** 原样再试有没有可能过（限流、卡台暂时不可用）。 */
  retryable?: boolean;
  errors: string[];
  warnings: string[];
  source: "local" | "cardplatform";
  /** 卡台预检通过后才有：账号现状和这张卡密的资格判断。 */
  account?: PreflightAccount;
  target?: { planKey: string; planName: string; paymentCountry: string; product: CardProduct };
  eligibility?: PreflightEligibility;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** 本地快速校验：合法 JSON + accessToken，失败则不必打卡台 */
export function checkChatGPTSessionLocal(raw: string): SessionCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = raw.trim();

  if (!text) {
    return {
      ok: false,
      hasAccessToken: false,
      errors: ["请粘贴 Session JSON"],
      warnings,
      source: "local",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      hasAccessToken: false,
      errors: ["不是合法 JSON。请打开 chatgpt.com/api/auth/session 后复制整页内容。"],
      warnings,
      source: "local",
    };
  }

  const root = asRecord(parsed);
  if (!root) {
    return {
      ok: false,
      hasAccessToken: false,
      errors: ["Session 应为 JSON 对象"],
      warnings,
      source: "local",
    };
  }

  const user = asRecord(root.user);
  const account = asRecord(root.account);
  const accessToken = pickString(
    root.accessToken,
    root.access_token,
    account?.accessToken,
    account?.access_token,
  );

  const email = pickString(user?.email, root.email, account?.email, asRecord(user?.user)?.email);
  const name = pickString(user?.name, root.name, account?.name);
  const planHint = pickString(
    root.planType,
    asRecord(root.account)?.planType,
    asRecord(asRecord(root.account)?.entitlement)?.subscription_plan,
  );

  if (!accessToken) {
    errors.push("缺少 accessToken。请确认复制的是登录后的完整 session JSON。");
  } else if (accessToken.length < 20) {
    errors.push("accessToken 过短，可能不是有效会话。");
  }

  return {
    ok: errors.length === 0,
    email,
    name,
    hasAccessToken: Boolean(accessToken),
    planHint,
    errors,
    warnings,
    source: "local",
  };
}

/**
 * 兑换凭证的本地格式校验，按卡密的产品线来：GPT 是 Session JSON，X 是登录 cookie JSON，
 * Grok 是 sso cookie。只有 GPT 和 X 能从凭证里读出邮箱。
 */
export function checkCredentialLocal(product: CardProduct, raw: string): SessionCheckResult {
  if (product === "gpt") return checkChatGPTSessionLocal(raw);
  const checked = product === "grok" ? grokCredential(raw) : xCredential(raw);
  if (!checked.ok) {
    return { ok: false, hasAccessToken: false, errors: [checked.error], warnings: [], source: "local" };
  }
  return {
    ok: true,
    email: product === "x" ? xCredentialEmail(checked.session) || undefined : undefined,
    hasAccessToken: true,
    errors: [],
    warnings: [],
    source: "local",
  };
}

/**
 * 不打卡台先猜卡密的产品线：本站发出的卡看本站套餐键；别处的卡用前端校验卡密时拿到的 product，
 * 都没有就当 GPT。真正以卡台 preview 为准，预检时还会再核一次。
 */
export async function codeProductHint(code: string, hint?: string | null): Promise<CardProduct> {
  const issued = await findIssuedCdkByCode(code.trim()).catch(() => null);
  if (issued?.planKey) {
    const plan = await db.query.platformPlans
      .findFirst({ where: eq(platformPlans.planKey, issued.planKey) })
      .catch(() => null);
    return isCardProduct(plan?.product) ? plan.product : productOfPlanKey(issued.planKey);
  }
  return isCardProduct(hint) ? hint : "gpt";
}

/** @deprecated 兼容旧引用；请用 checkChatGPTSessionLocal / verifySessionForRedeem */
export function checkChatGPTSession(raw: string): SessionCheckResult {
  return checkChatGPTSessionLocal(raw);
}

/**
 * 兑换前完整预检：本地格式 → 卡台 /api/v1/cdk/preflight → 按卡密套餐判断账号资格。
 * 卡台 ok 且资格没被拦下才算通过。
 */
export async function verifySessionForRedeem(
  raw: string,
  code?: string,
  productHint?: string | null,
): Promise<SessionCheckResult> {
  const product = code?.trim() ? await codeProductHint(code, productHint) : "gpt";
  const local = checkCredentialLocal(product, raw);
  if (!local.ok) return local;
  if (!code?.trim()) {
    return {
      ...local,
      ok: false,
      errors: ["请先校验卡密，再预检 Session"],
      source: "local",
    };
  }

  try {
    const preflight = await preflightRedeemableCdk({
      code: code.trim(),
      account: { mode: "session", session: raw.trim(), email: local.email },
    });
    const { account, redeemable } = preflight;
    if (redeemable.product !== product) {
      return {
        ...local,
        ok: false,
        errorCode: "CREDENTIAL_PRODUCT_MISMATCH",
        retryable: false,
        errors: [`这张卡密是 ${CARD_PRODUCTS[redeemable.product].label}，请粘贴对应的登录凭证。`],
        source: "cardplatform",
      };
    }
    const eligibility = assessEligibility(account, redeemable.planKey);
    const email = preflight.accountEmail || local.email;
    const ok = eligibility.verdict !== "block";
    const planLabel =
      account.currentPlan || account.currentPlanRaw
        ? accountPlanLabel(account.currentPlan, account.currentPlanRaw)
        : local.planHint;
    return {
      ok,
      email,
      name: local.name,
      hasAccessToken: true,
      planHint: planLabel,
      summary: {
        email,
        plan_type: planLabel,
        has_active_subscription: account.subscription.active ?? undefined,
        expires_at: account.subscription.expiresAt || undefined,
        expires_at_has_time: account.subscription.expiryHasTime,
      },
      errorCode: ok ? undefined : (eligibility.code ?? "PRECHECK_REJECTED"),
      retryable: ok ? undefined : false,
      errors: eligibility.reasons,
      warnings: eligibility.warnings,
      source: "cardplatform",
      account,
      target: {
        planKey: redeemable.planKey,
        planName: redeemable.planName,
        product: redeemable.product,
        paymentCountry: redeemable.paymentCountry || account.paymentCountry,
      },
      eligibility,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "卡台 Session 预检失败";
    const card = err instanceof CardplatformError ? err : null;
    return {
      ok: false,
      email: local.email,
      name: local.name,
      hasAccessToken: local.hasAccessToken,
      planHint: local.planHint,
      errorCode: card?.errorCode || "CARDPLATFORM_ERROR",
      httpStatus: card?.httpStatus || undefined,
      retryable: preflightRetryable(card?.errorCode, card?.httpStatus),
      errors: [message],
      warnings: [],
      source: "cardplatform",
    };
  }
}
