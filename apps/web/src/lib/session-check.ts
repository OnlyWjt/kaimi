/** ChatGPT Session 预检：本地格式 + 主站 POST /agent/session/check */

import { getUpstreamClient } from "@/lib/upstream";
import { UpstreamError } from "@kaimi/upstream";

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
  source: "local" | "upstream";
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

/** 本地快速校验：合法 JSON + accessToken，失败则不必打主站 */
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
 * 兑换前完整预检：本地格式 → 主站 /agent/session/check。
 * 只有主站 ok=true 才算通过（才能提交兑换）。
 */
export async function verifySessionForRedeem(raw: string): Promise<SessionCheckResult> {
  const local = checkChatGPTSessionLocal(raw);
  if (!local.ok) return local;

  try {
    const upstream = await getUpstreamClient();
    const res = await upstream.checkSession({ session: raw.trim() });

    if (!res.ok) {
      const msg =
        res.error ||
        (res.error_code === "SESSION_INVALID"
          ? "Session 无效或已过期，请重新登录后复制"
          : "Session 校验未通过");
      return {
        ok: false,
        email: res.email || local.email,
        name: local.name,
        hasAccessToken: local.hasAccessToken,
        planHint:
          typeof res.summary?.plan_type === "string" ? res.summary.plan_type : local.planHint,
        summary: res.summary,
        errorCode: res.error_code,
        errors: [msg],
        warnings: [],
        source: "upstream",
      };
    }

    const summary = res.summary;
    const planHint =
      (typeof summary?.plan_type === "string" && summary.plan_type) || local.planHint;
    const warnings: string[] = [];
    if (summary && summary.has_active_subscription === false) {
      warnings.push("当前账号没有有效订阅。");
    }

    return {
      ok: true,
      email: res.email || (typeof summary?.email === "string" ? summary.email : undefined) || local.email,
      name: local.name,
      hasAccessToken: true,
      planHint,
      summary,
      errors: [],
      warnings,
      source: "upstream",
    };
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) {
      return {
        ok: false,
        email: local.email,
        name: local.name,
        hasAccessToken: local.hasAccessToken,
        planHint: local.planHint,
        errorCode: "UNAUTHORIZED",
        errors: ["上游 API Key 无效或已吊销，请检查后台接入配置"],
        warnings: [],
        source: "upstream",
      };
    }
    const message = err instanceof Error ? err.message : "上游 Session 校验失败";
    return {
      ok: false,
      email: local.email,
      name: local.name,
      hasAccessToken: local.hasAccessToken,
      planHint: local.planHint,
      errorCode: "UPSTREAM_ERROR",
      errors: [message],
      warnings: [],
      source: "upstream",
    };
  }
}
