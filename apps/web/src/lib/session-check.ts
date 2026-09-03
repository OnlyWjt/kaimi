import { preflightRedeemableCdk } from "@/lib/cardplatform/redeem";
import { nestedString } from "@/lib/cardplatform/issued-redemption";

export type SessionSummary = {
  email?: string;
  plan_type?: string;
  has_active_subscription?: boolean;
  expires_at?: string;
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
  errors: string[];
  warnings: string[];
  source: "local" | "cardplatform";
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

/** @deprecated 兼容旧引用；请用 checkChatGPTSessionLocal / verifySessionForRedeem */
export function checkChatGPTSession(raw: string): SessionCheckResult {
  return checkChatGPTSessionLocal(raw);
}

/**
 * 兑换前完整预检：本地格式 → 卡台 /api/v1/cdk/preflight。
 * 只有卡台 ok 才算通过。
 */
export async function verifySessionForRedeem(
  raw: string,
  code?: string,
): Promise<SessionCheckResult> {
  const local = checkChatGPTSessionLocal(raw);
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
    const email =
      preflight.accountEmail ||
      nestedString(preflight.preflight, "email", "account_email") ||
      local.email;
    const planHint =
      nestedString(preflight.preflight, "plan_type", "plan", "plan_key") ||
      local.planHint;
    const warnings: string[] = [];
    const subscription = preflight.preflight.has_active_subscription;
    if (subscription === false) {
      warnings.push("当前账号没有有效订阅。");
    }

    return {
      ok: true,
      email,
      name: local.name,
      hasAccessToken: true,
      planHint,
      summary: {
        email,
        plan_type: planHint,
        has_active_subscription:
          typeof subscription === "boolean" ? subscription : undefined,
      },
      errors: [],
      warnings,
      source: "cardplatform",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "卡台 Session 预检失败";
    return {
      ok: false,
      email: local.email,
      name: local.name,
      hasAccessToken: local.hasAccessToken,
      planHint: local.planHint,
      errorCode: "CARDPLATFORM_ERROR",
      errors: [message],
      warnings: [],
      source: "cardplatform",
    };
  }
}
