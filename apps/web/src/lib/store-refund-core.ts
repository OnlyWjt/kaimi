import { isLocalAccountPlan } from "@/lib/finished-account-core";

export type RefundCdk = {
  id: number;
  status: string;
  planKey: string;
  upstreamRef: string;
  cardplatformAccountId: number;
};

export function isFinishedDelivery(cdk: Omit<RefundCdk, "id" | "status">) {
  return (
    isLocalAccountPlan(cdk) ||
    cdk.cardplatformAccountId === 0 ||
    cdk.upstreamRef.startsWith("finished:")
  );
}

/**
 * 退款前把卡分成两类：
 * - inFlight：卡台卡密占用中/兑换中，结果不确定，必须先人工核对，不能登记。
 * - redeemed：卡台卡密已被买家兑换，卡台退不了卡；拒付基本都是这种情况。
 *   管理员确认由平台承担成本后可以继续登记，只改本地账务，不动卡台。
 * 成品号不在卡台，已使用照常在本地禁用，两类都不算。
 */
export function classifyRefundCdks(cdks: RefundCdk[]) {
  const inFlight: number[] = [];
  const redeemed: number[] = [];
  for (const cdk of cdks) {
    if (isFinishedDelivery(cdk)) continue;
    if (cdk.status === "locked" || cdk.status === "redeeming") inFlight.push(cdk.id);
    else if (cdk.status === "used") redeemed.push(cdk.id);
  }
  return { inFlight, redeemed };
}
