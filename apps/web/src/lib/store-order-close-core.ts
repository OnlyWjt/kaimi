export type GatewayPaidCheck = "paid" | "unpaid" | "error";

/** 网关一直查不清时，最多再等这么久就关单，免得优惠券次数永远被占着。 */
export const STORE_ORDER_GATEWAY_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** 把向网关补查的结果归成三种：已付（已经按付款确认）、确实没付、查不清。 */
export function gatewayPaidCheckOutcome(result: { kind: string }): GatewayPaidCheck {
  if (result.kind === "ok") return "paid";
  if (result.kind === "unpaid" || result.kind === "missing") return "unpaid";
  return "error";
}

/**
 * 超时未付款的单补查网关后要不要关。
 * 已付的绝不关；确认没付的关；查不清的先留着，过了放弃时限才关。
 */
export function shouldCloseUnpaidOrder(input: {
  check: GatewayPaidCheck | null;
  createdAt: string;
  now: Date;
}) {
  if (input.check === null || input.check === "unpaid") return true;
  if (input.check === "paid") return false;
  const giveUp = new Date(input.now.getTime() - STORE_ORDER_GATEWAY_GIVE_UP_MS).toISOString();
  return input.createdAt < giveUp;
}
