"use client";

/** 兑换页（单张 / 批量）共用的小部件。 */

const STEPS = ["校验卡密", "填写账号", "开通"] as const;

/** 单张兑换的三步进度条。current 从 0 开始；done 表示第三步也已结束。 */
export function RedeemSteps({ current, done = false }: { current: 0 | 1 | 2; done?: boolean }) {
  return (
    <ol className="km-rx-steps" aria-label="兑换步骤">
      {STEPS.map((label, index) => {
        const state = index < current || (done && index === current) ? "done" : index === current ? "now" : "todo";
        return (
          <li key={label} className={`km-rx-step km-rx-step-${state}`} aria-current={state === "now" ? "step" : undefined}>
            <span className="km-rx-step-dot" aria-hidden>
              {state === "done" ? "✓" : index + 1}
            </span>
            <span className="km-rx-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 去哪里拿 Session。 */
export function SessionGuide() {
  return (
    <ol className="km-rx-guide">
      <li>在浏览器里登录要开通的 ChatGPT 账号</li>
      <li>
        打开{" "}
        <a href="https://chatgpt.com/api/auth/session" target="_blank" rel="noreferrer">
          chatgpt.com/api/auth/session
        </a>
      </li>
      <li>全选复制整页内容，粘贴到上面</li>
    </ol>
  );
}

/** 凭证方式切换：Session / 邮箱密码。 */
export function CredentialSwitch({
  value,
  onChange,
}: {
  value: "session" | "mailbox";
  onChange: (mode: "session" | "mailbox") => void;
}) {
  return (
    <div className="km-rx-seg km-rx-seg-sm" role="tablist" aria-label="开通方式">
      {(
        [
          ["session", "Session"],
          ["mailbox", "邮箱密码"],
        ] as const
      ).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          role="tab"
          aria-selected={value === mode}
          className={`km-rx-seg-item${value === mode ? " km-rx-seg-item-active" : ""}`}
          onClick={() => onChange(mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
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

/** 卡密太短就别发请求了，接口只会回一句看不懂的参数错误。 */
export const MIN_CODE_LENGTH = 6;
