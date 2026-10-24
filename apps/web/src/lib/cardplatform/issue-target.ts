import { supportsPaymentCountry } from "./protocol";
import { normalizePaymentCountry } from "./regions";
import { isCardProduct, issuePaymentCountry, productOfPlanKey, upstreamIssuePlanKey } from "./product";

/**
 * 订单 / 提卡单快照 → 发给卡台的 plan 和地区。
 * 商城发卡和自助提卡共用，保证两边规则一致。
 */
export function issueTargetFromSnapshot(snapshot: {
  planKeySnapshot: string;
  upstreamPlanKeySnapshot?: string | null;
  paymentCountrySnapshot?: string | null;
  /** 下单时的产品线。老订单没有，按 plan_key 推。 */
  productSnapshot?: string | null;
}) {
  const plan = snapshot.upstreamPlanKeySnapshot?.trim() || snapshot.planKeySnapshot;
  const paymentCountry = normalizePaymentCountry(snapshot.paymentCountrySnapshot);
  const product = isCardProduct(snapshot.productSnapshot)
    ? snapshot.productSnapshot
    : productOfPlanKey(snapshot.planKeySnapshot);
  if (product === "gpt") return { plan, paymentCountry };
  // X / Grok 兜底：上游键按产品规则重算（老快照可能还带着 x_ 前缀），地区不能空——
  // 空串在 GPT 是菲区，在这两条线上卡台会拒。Grok 固定 US，X 缺省 JP。
  return {
    plan: upstreamIssuePlanKey(product, plan),
    paymentCountry: issuePaymentCountry(product, paymentCountry),
  };
}

/** 环境变量账户（id 0）按旧台协议处理。 */
export function accountSupportsPaymentCountry(account: {
  id: number;
  protocol?: string | null;
}) {
  return account.id === 0 || supportsPaymentCountry(account.protocol ?? "");
}

/**
 * 卡台拒绝付款地区的错误。上游确切错误码待确认，先按关键词识别。
 * 超时、结果未知不算：那种要走找回，不能当成地区失败。
 */
export function isRegionIssueError(error: {
  errorCode?: string;
  message?: string;
  outcomeUnknown?: boolean;
}) {
  if (error.outcomeUnknown) return false;
  const text = `${error.errorCode || ""} ${error.message || ""}`.toLowerCase();
  return /region|country|currency|地区|币种/.test(text);
}
