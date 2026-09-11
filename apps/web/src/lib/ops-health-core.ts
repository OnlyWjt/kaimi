export const DEFAULT_MIN_SPENDABLE_CENTS = 500;
export const DEFAULT_WARN_SPENDABLE_CENTS = 15_000;
export const CARDPLATFORM_BALANCE_TIMEOUT_MS = 45_000;

export const CARDPLATFORM_UNREACHABLE = "cardplatform.unreachable";
export const CARDPLATFORM_LOW_BALANCE = "cardplatform.low_balance";
export const CARDPLATFORM_LOW_BALANCE_WARN = "cardplatform.low_balance_warn";
export const CARDPLATFORM_NO_PLANS = "cardplatform.no_plans";
export const JOBS_FAILED = "jobs.failed";

export type OpsNotifyKind = "alert" | "warn" | "recovered";

export type OpsNotifyBody = {
  kind: OpsNotifyKind;
  what: string;
  impact: string;
  action: string;
};

export type CardplatformIssue = {
  code: string;
  level: "warning" | "critical";
  notify: OpsNotifyBody;
};

export type CardplatformVerdict = {
  ok: boolean;
  closeSales: boolean;
  spendableCents: number | null;
  currency: string;
  message: string;
  issue: CardplatformIssue | null;
};

export type OpsHealthNotifySnapshot = {
  salesOpen: boolean;
  cardplatformCode: string | null;
  jobsFailed: number;
};

export function formatOpsMoney(cents: number, currency: string) {
  return `${(cents / 100).toFixed(2)} ${currency || "USD"}`;
}

export function formatOpsNotifyText(body: OpsNotifyBody) {
  const title =
    body.kind === "recovered" ? "运维恢复" : body.kind === "warn" ? "运维提醒" : "运维告警";
  return [`[Kaimi] ${title}`, body.what, body.impact, body.action]
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function humanizeCardplatformError(raw: string) {
  const text = raw.trim();
  if (!text) return "卡台检查失败，原因不明。";
  if (
    /aborted due to timeout|TimeoutError|signal timed out|The operation was aborted/i.test(
      text,
    )
  ) {
    return `查卡台余额超时，等了 ${CARDPLATFORM_BALANCE_TIMEOUT_MS / 1000} 秒没回来。`;
  }
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|UND_ERR|undici/i.test(text)) {
    return "连不上卡台，网络或域名解析失败。";
  }
  if (/certificate|CERT_|UNABLE_TO_VERIFY|ERR_TLS/i.test(text)) {
    return "卡台 HTTPS 证书校验失败。";
  }
  if (/API Key 未配置|unauthorized|HTTP 401/i.test(text)) {
    return "卡台 API Key 无效或未配置。";
  }
  if (/账户未配置|卡台未配置/.test(text)) {
    return "还没有配置可用的卡台账户。";
  }
  if (/HTML|无效响应/.test(text)) {
    return "卡台返回了网页而不是接口，地址或密钥可能不对。";
  }
  if (/[\u4e00-\u9fff]/.test(text)) return text;
  return "卡台检查失败，详细原因已写进服务器日志。";
}

export function classifyCardplatformHealth(input: {
  spendableCents: number | null;
  minCents: number;
  warnCents: number;
  currency: string;
  error?: string;
  hasSellablePlan: boolean;
}): CardplatformVerdict {
  const currency = input.currency || "USD";
  const minCents = Math.max(0, input.minCents);
  const warnCents = Math.max(minCents, input.warnCents);

  if (input.error) {
    const what = humanizeCardplatformError(input.error);
    return {
      ok: false,
      closeSales: true,
      spendableCents: null,
      currency,
      message: what,
      issue: {
        code: CARDPLATFORM_UNREACHABLE,
        level: "critical",
        notify: {
          kind: "alert",
          what,
          impact: "店已自动暂停售卖。顾客只会看到「暂时停止售卖」。",
          action: "先看卡台和网络。卡台恢复后下一轮检查会自动开店，不用改配置。",
        },
      },
    };
  }

  if (input.spendableCents == null) {
    return {
      ok: false,
      closeSales: true,
      spendableCents: null,
      currency,
      message: "卡台未返回可用余额。",
      issue: {
        code: CARDPLATFORM_UNREACHABLE,
        level: "critical",
        notify: {
          kind: "alert",
          what: "卡台接口通了，但没有返回可用余额。",
          impact: "店已自动暂停售卖，避免继续接单却发不出卡。",
          action: "到卡台后台看余额接口，修好后下一轮检查会自动开店。",
        },
      },
    };
  }

  const spendable = input.spendableCents;
  const money = formatOpsMoney(spendable, currency);
  const minMoney = formatOpsMoney(minCents, currency);
  const warnMoney = formatOpsMoney(warnCents, currency);

  if (spendable < minCents) {
    return {
      ok: false,
      closeSales: true,
      spendableCents: spendable,
      currency,
      message: `卡台可用余额 ${money}，低于关店线 ${minMoney}`,
      issue: {
        code: CARDPLATFORM_LOW_BALANCE,
        level: "critical",
        notify: {
          kind: "alert",
          what: `卡台可用余额 ${money}，已经低于关店线 ${minMoney}。`,
          impact: "店已自动暂停售卖，避免继续接单却发不出卡。",
          action: "请马上给卡台充值。充好后下一轮检查会自动开店。",
        },
      },
    };
  }

  if (!input.hasSellablePlan) {
    return {
      ok: false,
      closeSales: true,
      spendableCents: spendable,
      currency,
      message: "没有可售卡台套餐",
      issue: {
        code: CARDPLATFORM_NO_PLANS,
        level: "critical",
        notify: {
          kind: "alert",
          what: "卡台余额正常，但本站没有可售的卡台套餐。",
          impact: "店已自动暂停售卖。",
          action: "到「接入卡台」同步套餐，并确认至少有一个套餐标成可售。",
        },
      },
    };
  }

  if (spendable < warnCents) {
    return {
      ok: true,
      closeSales: false,
      spendableCents: spendable,
      currency,
      message: `卡台可用余额 ${money}，已低于预警线 ${warnMoney}`,
      issue: {
        code: CARDPLATFORM_LOW_BALANCE_WARN,
        level: "warning",
        notify: {
          kind: "warn",
          what: `卡台可用余额 ${money}，已低于预警线 ${warnMoney}。`,
          impact: "店还开着，但余额快不够继续发卡。",
          action: `请尽快给卡台充值。关店线是 ${minMoney}。`,
        },
      },
    };
  }

  return {
    ok: true,
    closeSales: false,
    spendableCents: spendable,
    currency,
    message: `卡台可用余额 ${money}`,
    issue: null,
  };
}

export function jobsFailedNotify(failed: number): OpsNotifyBody {
  return {
    kind: "warn",
    what: `有 ${failed} 个后台任务失败。`,
    impact: "店铺购买还开着，发卡或对账可能卡住。",
    action: "打开管理后台「即时发卡」，看失败任务并重试。",
  };
}

export function cardplatformRecoveredNotify(input: {
  spendableCents: number | null;
  currency: string;
  shopWasClosed: boolean;
}): OpsNotifyBody {
  const money =
    input.spendableCents == null ? "" : formatOpsMoney(input.spendableCents, input.currency);
  return {
    kind: "recovered",
    what: money ? `卡台检查已恢复正常，可用余额 ${money}。` : "卡台检查已恢复正常。",
    impact: input.shopWasClosed
      ? "店铺购买已重新开放。"
      : "店一直开着，余额预警已经解除。",
    action: "不用动手。刚才的告警可以当作已经过去。",
  };
}

export function opsHealthNotifications(
  previous: OpsHealthNotifySnapshot | null,
  current: OpsHealthNotifySnapshot,
  currentIssue: CardplatformIssue | null,
  recovered: OpsNotifyBody | null,
  jobsNotify: OpsNotifyBody | null,
): OpsNotifyBody[] {
  const out: OpsNotifyBody[] = [];
  const prevCode = previous?.cardplatformCode ?? null;
  if (current.cardplatformCode && current.cardplatformCode !== prevCode && currentIssue) {
    out.push(currentIssue.notify);
  }
  const leftCardplatformIssue = Boolean(prevCode) && !current.cardplatformCode;
  if (leftCardplatformIssue && recovered) {
    out.push(recovered);
  }
  if (jobsNotify && current.jobsFailed > 0 && (previous?.jobsFailed ?? 0) === 0) {
    out.push(jobsNotify);
  }
  return out;
}
