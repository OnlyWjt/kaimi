import { db } from "@/db";
import { platformPlans } from "@/db/schema";
import { eq } from "drizzle-orm";
import { maskCode } from "@/lib/crypto";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { planNameWithRegion } from "./regions";
import type { AgentCredential } from "@/lib/recharge-types";
import {
  getCardplatformClientById,
  getDefaultCardplatformClient,
} from "./config";
import { observeFromPublicResult } from "./health";
import { parseRedeemResult } from "@/lib/redeem-timeline-core";
import {
  cardplatformMessage,
  findIssuedCdkByCode,
  nestedString,
} from "./issued-redemption";
import { mapCardplatformStatus, parseCardplatformRequestId } from "./status";
import { CardplatformError } from "./client";
import { parsePreflight, preflightErrorMessage } from "./preflight-core";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";

export {
  mapCardplatformStatus,
  parseCardplatformRequestId,
  redeemOutcomeStatus,
  requestIdForRedeem,
} from "./status";

export type RedeemableCdk = {
  code: string;
  planKey: string;
  planName: string;
  /** 本站卡密且套餐有地区概念时才有值。空串 = 菲区。 */
  paymentCountry: string;
  regionLabel: string;
  accountId: number;
  issued: NonNullable<Awaited<ReturnType<typeof findIssuedCdkByCode>>> | null;
};

export function cardplatformCredential(account: AgentCredential) {
  return { mode: "session" as const, session: String(account.session || "") };
}

async function planInfoFor(planKey: string) {
  if (!planKey) return null;
  const plan = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.planKey, planKey),
  });
  if (!plan) return null;
  return {
    name: planNameWithRegion(
      plan.name,
      plan.regionCapable,
      plan.paymentCountry,
      plan.regionLabel,
    ),
    paymentCountry: plan.regionCapable ? plan.paymentCountry : "",
    regionLabel: plan.regionCapable ? plan.regionLabel : "",
    regionCapable: plan.regionCapable,
  };
}

export async function resolveRedeemClient(code: string) {
  const issued = await findIssuedCdkByCode(code);
  if (issued) {
    if (isLocalAccountPlan(issued)) {
      throw new Error("成品账号无需兑换，请到订单页查看。");
    }
    const { client, account } = await getCardplatformClientById(
      issued.cardplatformAccountId,
      { allowDisabled: true },
    );
    return { issued, client, accountId: account.id };
  }
  const { client, account } = await getDefaultCardplatformClient();
  return { issued: null, client, accountId: account.id };
}

export async function previewRedeemableCdk(
  code: string,
  options: { allowInFlight?: boolean } = {},
): Promise<{
  redeemable: RedeemableCdk;
  payload: Record<string, unknown>;
  redemptionToken: string;
}> {
  const trimmed = code.trim();
  if (!trimmed || trimmed.length < REDEEM_CODE_MIN_LENGTH) {
    throw new Error("请输入完整卡密");
  }
  const issued = await findIssuedCdkByCode(trimmed);
  if (issued) {
    if (isLocalAccountPlan(issued)) {
      throw new Error("成品账号无需兑换，请到订单页查看。");
    }
    if (issued.status === "used") throw new Error("该卡密已使用");
    // 兑换流程会先把卡抢成 locked，再去预检，而预检里又要 preview 一次。不给持锁人
    // 放行的话，本站发出去的卡一张都兑不掉——抢到锁的那一步就把自己挡在门外了。
    if (
      !options.allowInFlight &&
      (issued.status === "locked" || issued.status === "redeeming")
    ) {
      throw new Error("该卡密兑换处理中，请稍后查询");
    }
    if (issued.status === "disabled") throw new Error("该卡密已禁用");
  }

  const { client, accountId } = await resolveRedeemClient(trimmed);
  const result = await client.previewCdk(issued?.code || trimmed);
  if (!result.ok) throw publicCdkError(result);
  const redemptionToken = nestedString(
    result.payload,
    "redemption_token",
    "token",
  );
  if (!redemptionToken) throw new Error("卡台未返回兑换令牌");

  const planKey =
    issued?.planKey ||
    nestedString(result.payload, "plan", "plan_key", "product") ||
    "";
  const planInfo = await planInfoFor(planKey);
  return {
    redeemable: {
      code: issued?.code || trimmed,
      planKey,
      planName: planInfo?.name || planKey || "卡台套餐",
      paymentCountry: issued && planInfo?.regionCapable ? issued.paymentCountry : "",
      regionLabel: issued && planInfo?.regionCapable ? planInfo.regionLabel : "",
      accountId,
      issued,
    },
    payload: result.payload,
    redemptionToken,
  };
}

export async function preflightRedeemableCdk(input: {
  code: string;
  account: AgentCredential;
  /** 调用方已经持有这张卡的锁时传 true，否则会被自己刚上的锁挡住。 */
  allowInFlight?: boolean;
}) {
  const preview = await previewRedeemableCdk(input.code, {
    allowInFlight: input.allowInFlight,
  });
  const { client } = await resolveRedeemClient(preview.redeemable.code);
  const result = await client.preflightCdk({
    code: preview.redeemable.code,
    redemption_token: preview.redemptionToken,
    credential: cardplatformCredential(input.account),
  });
  if (!result.ok) throw publicCdkError(result);
  const account = parsePreflight(result.payload);
  const preflightToken =
    account.preflightToken || nestedString(result.payload, "preflight_token", "token");
  if (!preflightToken) throw new Error("卡台未返回预检令牌");
  return {
    ...preview,
    preflight: result.payload,
    account,
    preflightToken,
    accountEmail: account.email || input.account.email || "",
  };
}

/**
 * 卡台公开兑换接口的失败。带上 error_code 和 HTTP 状态往上抛：调用方要按码区分
 * 「Session 坏了」「套餐还有效」「被限流」，只剩一句 msg 就只能统一报卡台错误。
 */
function publicCdkError(result: { status: number; payload: Record<string, unknown> }) {
  const errorCode = nestedString(result.payload, "error_code");
  return new CardplatformError({
    message: preflightErrorMessage(errorCode, cardplatformMessage(result.payload)),
    httpStatus: result.status,
    errorCode,
  });
}

export async function pollCardplatformResult(requestId: string) {
  const parsed = parseCardplatformRequestId(requestId);
  if (!parsed) throw new Error("卡台兑换请求标识无效");
  const { client } = await getCardplatformClientById(parsed.accountId, {
    allowDisabled: true,
  });
  const result = await client.getCdkResult(parsed.token);
  if (!result.ok) throw new Error(cardplatformMessage(result.payload));
  await observeFromPublicResult(result.payload, parsed.accountId);
  // 面向用户那句话在 order.message 里，nestedString 只看顶层和 data，看不到它。
  const upstream = parseRedeemResult(result.payload);
  return {
    payload: result.payload,
    upstream,
    status: mapCardplatformStatus(result.payload, true),
    message:
      upstream.order.message ||
      nestedString(result.payload, "message", "msg") ||
      "卡台处理中",
  };
}

export function summarizePreview(input: {
  redeemable: RedeemableCdk;
}) {
  return {
    ok: true as const,
    codeMasked: maskCode(input.redeemable.code),
    status: "未使用",
    planKey: input.redeemable.planKey,
    planName: input.redeemable.planName,
    paymentCountry: input.redeemable.paymentCountry,
    regionLabel: input.redeemable.regionLabel,
    productId: null as number | null,
    price: undefined as string | undefined,
  };
}
