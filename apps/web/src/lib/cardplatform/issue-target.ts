import { supportsPaymentCountry } from "./protocol";
import { normalizePaymentCountry } from "./regions";

/**
 * 订单 / 提卡单快照 → 发给卡台的 plan 和地区。
 * 商城发卡和自助提卡共用，保证两边规则一致。
 */
export function issueTargetFromSnapshot(snapshot: {
  planKeySnapshot: string;
  upstreamPlanKeySnapshot?: string | null;
  paymentCountrySnapshot?: string | null;
}) {
  const plan = snapshot.upstreamPlanKeySnapshot?.trim() || snapshot.planKeySnapshot;
  return {
    plan,
    paymentCountry: normalizePaymentCountry(snapshot.paymentCountrySnapshot),
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
