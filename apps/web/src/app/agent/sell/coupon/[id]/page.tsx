import { AgentCouponComposer } from "@/components/agent-coupon-composer";

export default async function AgentEditCouponPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const couponId = Number((await params).id);
  return <AgentCouponComposer couponId={Number.isSafeInteger(couponId) ? couponId : undefined} />;
}
