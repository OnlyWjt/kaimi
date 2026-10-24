"use client";

import type { ReactNode } from "react";
import type { CardProduct } from "@/lib/cardplatform/product";
import { formatBeijingDateTime } from "@/lib/datetime";

/** 兑换页（单张 / 批量）共用的小部件。 */

const STEPS = ["校验卡密", "填写账号", "开通"] as const;

type StepState = "done" | "now" | "todo" | "failed";

/**
 * 单张兑换的三步进度条。current 从 0 开始；
 * outcome 是第三步的结果：success 打勾，failed 标红，不传就是还在进行。
 */
export function RedeemSteps({
  current,
  outcome,
}: {
  current: 0 | 1 | 2;
  outcome?: "success" | "failed";
}) {
  return (
    <ol className="km-rx-steps" aria-label="兑换步骤">
      {STEPS.map((label, index) => {
        const state: StepState =
          index < current
            ? "done"
            : index > current
              ? "todo"
              : outcome === "success"
                ? "done"
                : outcome === "failed"
                  ? "failed"
                  : "now";
        return (
          <li
            key={label}
            className={`km-rx-step km-rx-step-${state}`}
            aria-current={state === "now" || state === "failed" ? "step" : undefined}
          >
            <span className="km-rx-step-dot" aria-hidden>
              {state === "done" ? "✓" : state === "failed" ? "!" : index + 1}
            </span>
            <span className="km-rx-step-label">{state === "failed" ? `${label}失败` : label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 各产品线兑换要粘贴的凭证：名字、输入框提示、去哪里拿。 */
const CREDENTIAL_COPY: Record<CardProduct, { name: string; label: string; placeholder: string; guide: ReactNode[] }> = {
  gpt: {
    name: "Session",
    label: "ChatGPT Session",
    placeholder: '整页 JSON，形如 { "user": {…}, "accessToken": "…" }',
    guide: [
      "在浏览器里登录要开通的 ChatGPT 账号",
      <>
        打开{" "}
        <a href="https://chatgpt.com/api/auth/session" target="_blank" rel="noreferrer">
          chatgpt.com/api/auth/session
        </a>
      </>,
      "全选复制整页内容，粘贴到上面",
    ],
  },
  grok: {
    name: "Grok 登录凭证",
    label: "Grok 登录凭证（sso cookie）",
    placeholder: "sso=eyJ…，也可以只粘 sso 的值",
    guide: [
      <>
        在浏览器里登录要开通的 Grok 账号：{" "}
        <a href="https://grok.com" target="_blank" rel="noreferrer">
          grok.com
        </a>
      </>,
      "按 F12 打开开发者工具，进「应用 / Application」→「Cookie」→ https://grok.com",
      "找到名为 sso 的一项，复制它的值粘贴到上面",
    ],
  },
  x: {
    name: "X 登录凭证",
    label: "X 登录凭证",
    placeholder: '{ "billing_email": "账单邮箱", "auth_token": "…", "ct0": "…" }',
    guide: [
      <>
        在浏览器里登录要开通的 X 账号：{" "}
        <a href="https://x.com" target="_blank" rel="noreferrer">
          x.com
        </a>
      </>,
      "按 F12 打开开发者工具，进「应用 / Application」→「Cookie」→ https://x.com，复制 auth_token 和 ct0 的值",
      "按上面的格式填成 JSON，billing_email 填收账单的邮箱",
    ],
  },
};

/** 凭证的叫法：「Session」「Grok 登录凭证」…，按钮和提示里用。 */
export function credentialName(product: CardProduct = "gpt") {
  return CREDENTIAL_COPY[product].name;
}

/** 去哪里拿兑换凭证。 */
export function SessionGuide({ product = "gpt" }: { product?: CardProduct }) {
  return (
    <ol className="km-rx-guide">
      {CREDENTIAL_COPY[product].guide.map((step, index) => (
        <li key={index}>{step}</li>
      ))}
    </ol>
  );
}

/** 凭证输入框加获取步骤，按卡密的产品线换文案。 */
export function SessionField({
  value,
  onChange,
  product = "gpt",
}: {
  value: string;
  onChange: (value: string) => void;
  product?: CardProduct;
}) {
  const copy = CREDENTIAL_COPY[product];
  return (
    <>
      <label className="km-rx-field">
        <span className="km-rx-field-label">{copy.label}</span>
        <textarea
          className="km-input km-rx-session"
          placeholder={copy.placeholder}
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <SessionGuide product={product} />
    </>
  );
}

export type SessionPreview = {
  ok: boolean;
  email?: string;
  name?: string;
  hasAccessToken?: boolean;
  planHint?: string;
  summary?: {
    email?: string;
    plan_type?: string;
    has_active_subscription?: boolean;
    expires_at?: string;
    /** 卡台只给了日期时传 false，页面照原样显示日期，不补 00:00。 */
    expires_at_has_time?: boolean;
    /** Grok 半价卡密才有：有没有首月半价资格，null = 确认不了。 */
    first_month_half_eligible?: boolean | null;
    account_id?: string;
  };
  errors?: string[];
  warnings?: string[];
  source?: string;
  error?: string;
  error_code?: string;
  retryable?: boolean;
  /** ok / warn / block：卡台预检通过后按卡密套餐判断的资格。 */
  verdict?: "ok" | "warn" | "block";
  target?: { planKey: string; planName: string; paymentCountry: string; product?: CardProduct };
};

/** Session 预检的结果框。 */
export function SessionCheckResult({
  preview,
  product = "gpt",
}: {
  preview: SessionPreview;
  product?: CardProduct;
}) {
  const name = credentialName(product);
  const plan = preview.summary?.plan_type || preview.planHint;
  const active = preview.summary?.has_active_subscription;
  const firstMonthHalf = preview.summary?.first_month_half_eligible;
  // Session 本身没问题、是账号不符合这张卡的条件：照样把账号现状亮出来，买家才知道为什么不行。
  const ineligible = !preview.ok && preview.verdict === "block";
  const title = preview.ok
    ? `${name} 预检通过`
    : ineligible
      ? "这个账号不能兑换这张卡密"
      : `${name} 预检未通过`;
  return (
    <div className={`km-rx-check km-submit-reveal ${preview.ok ? "km-rx-check-pass" : "km-rx-check-fail"}`}>
      <p className="km-rx-check-title">{title}</p>
      {preview.ok || ineligible ? (
        <dl className="km-rx-meta">
          {preview.email ? <MetaItem label="账号" value={preview.email} /> : null}
          {preview.name ? <MetaItem label="显示名" value={preview.name} /> : null}
          {plan ? <MetaItem label="当前订阅" value={String(plan)} /> : null}
          {typeof active === "boolean" ? <MetaItem label="有效订阅" value={active ? "是" : "否"} /> : null}
          {preview.summary?.expires_at ? (
            <MetaItem
              label="到期"
              value={formatExpiry(
                preview.summary.expires_at,
                preview.summary.expires_at_has_time !== false,
              )}
            />
          ) : null}
          {firstMonthHalf !== undefined ? (
            <MetaItem
              label="首月半价资格"
              value={
                firstMonthHalf === true
                  ? "✅ 有"
                  : firstMonthHalf === false
                    ? "❌ 无（半价卡密无法使用）"
                    : "未确认（半价卡密暂不能使用）"
              }
            />
          ) : null}
        </dl>
      ) : null}
      {preview.errors?.map((msg) => (
        <p key={msg} className="km-rx-check-error">
          {msg}
        </p>
      ))}
      {preview.warnings?.map((msg) => (
        <p key={msg} className="km-rx-check-warn">
          {msg}
        </p>
      ))}
    </div>
  );
}

/**
 * 订阅到期：卡台给到时间点就按北京时间显示到分钟，只给日期就照原样给。
 * 不看浏览器时区，代理在哪儿看到的都一样。
 */
function formatExpiry(value: string, hasTime: boolean) {
  if (!hasTime) return value;
  return formatBeijingDateTime(value).slice(0, 16);
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * 读接口返回。网关出错时回的是 HTML，直接 res.json() 会把 `Unexpected token '<'` 甩给买家；
 * 这里读不出 JSON 就当成一条带中文 error 的返回，调用方照常按 res.ok / data.error 处理。
 */
// 和 readApiJson 一样返回宽松类型，调用方直接点字段。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readRedeemJson(res: Response): Promise<Record<string, any>> {
  const raw = await res.text();
  if (!raw.trim()) return {};
  try {
    const data: unknown = JSON.parse(raw);
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return { error: `服务暂时不可用（HTTP ${res.status}），请稍后再试` };
  }
}

/** 接口报错转成给买家看的话。被风控限流时告诉他大概等多久，而不是只说「太频繁」。 */
export function redeemApiError(data: unknown, fallback: string) {
  const body = (data && typeof data === "object" ? data : {}) as { error?: unknown; retry_after?: unknown };
  const retryAfter = Number(body.retry_after);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    const minutes = Math.ceil(retryAfter / 60);
    return minutes > 1 ? `尝试次数太多，请 ${minutes} 分钟后再试` : "尝试次数太多，请稍后再试";
  }
  return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
}
