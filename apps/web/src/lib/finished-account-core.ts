export const FINISHED_GPT_PLAN_KEY = "finished_gpt";
export const FINISHED_ACCOUNT_SEP = "----";
export const LOCAL_ACCOUNT_FULFILLMENT = "local_account";
export const CARDPLATFORM_FULFILLMENT = "cardplatform";
export const FINISHED_GPT_COST_CENTS = 300;
export const FINISHED_SESSION_MIN = 20;

export type FinishedAccountParts = {
  email: string;
  gptPassword: string;
  mailboxPassword: string;
  session: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLocalAccountPlan(input: {
  planKey?: string | null;
  fulfillmentKind?: string | null;
}) {
  return (
    input.fulfillmentKind === LOCAL_ACCOUNT_FULFILLMENT ||
    input.planKey === FINISHED_GPT_PLAN_KEY
  );
}

export function formatFinishedAccountLine(parts: FinishedAccountParts) {
  return [
    parts.email,
    parts.gptPassword,
    parts.mailboxPassword,
    parts.session,
  ].join(FINISHED_ACCOUNT_SEP);
}

export function parseFinishedAccountLine(raw: string): FinishedAccountParts {
  const line = raw.trim().replace(/^\uFEFF/, "");
  if (!line) throw new Error("空行");
  const parts = line.split(FINISHED_ACCOUNT_SEP);
  if (parts.length !== 4) {
    throw new Error("格式应为 邮箱----GPT密码----邮箱密码----Session");
  }
  const email = parts[0].trim().toLowerCase();
  const gptPassword = parts[1].trim();
  const mailboxPassword = parts[2].trim();
  const session = parts[3].trim();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    throw new Error("邮箱无效");
  }
  if (!gptPassword) throw new Error("GPT 密码不能为空");
  if (!mailboxPassword) throw new Error("邮箱密码不能为空");
  if (session.length < FINISHED_SESSION_MIN) {
    throw new Error(`Session 太短，至少 ${FINISHED_SESSION_MIN} 个字符`);
  }
  return { email, gptPassword, mailboxPassword, session };
}

export function parseFinishedAccountLines(text: string) {
  const accepted: FinishedAccountParts[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  const seen = new Set<string>();
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  rows.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    try {
      const parts = parseFinishedAccountLine(line);
      if (seen.has(parts.email)) {
        rejected.push({ line: index + 1, reason: "这份里邮箱重复" });
        return;
      }
      seen.add(parts.email);
      accepted.push(parts);
    } catch (error) {
      rejected.push({
        line: index + 1,
        reason: error instanceof Error ? error.message : "格式无效",
      });
    }
  });
  return { accepted, rejected };
}

export function maskFinishedSecret(value: string) {
  const text = value.trim();
  if (text.length <= 4) return "****";
  if (text.length <= 8) return `${text.slice(0, 1)}****${text.slice(-1)}`;
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}
