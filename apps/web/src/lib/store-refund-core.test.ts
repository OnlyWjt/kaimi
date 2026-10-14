import { describe, expect, it } from "vitest";
import { classifyRefundCdks, type RefundCdk } from "@/lib/store-refund-core";

function cdk(id: number, status: string, extra: Partial<RefundCdk> = {}): RefundCdk {
  return { id, status, planKey: "pro20x", upstreamRef: String(1000 + id), cardplatformAccountId: 1, ...extra };
}

describe("classifyRefundCdks", () => {
  it("卡台卡密已兑换归为 redeemed，未使用不拦", () => {
    expect(classifyRefundCdks([cdk(1, "used"), cdk(2, "unused")])).toEqual({ inFlight: [], redeemed: [1] });
  });

  it("占用中/兑换中归为 inFlight", () => {
    expect(classifyRefundCdks([cdk(1, "locked"), cdk(2, "redeeming"), cdk(3, "used")])).toEqual({
      inFlight: [1, 2],
      redeemed: [3],
    });
  });

  it("成品号不在卡台，已使用也不拦", () => {
    expect(
      classifyRefundCdks([
        cdk(1, "used", { planKey: "finished_gpt" }),
        cdk(2, "used", { cardplatformAccountId: 0 }),
        cdk(3, "used", { upstreamRef: "finished:9" }),
      ]),
    ).toEqual({ inFlight: [], redeemed: [] });
  });
});
