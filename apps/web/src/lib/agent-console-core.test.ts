import { describe, expect, it } from "vitest";
import {
  couponFaceHint,
  couponFaceLabel,
  couponUsesLabel,
  couponUsesRatio,
  dealLine,
} from "./agent-console-core";

describe("coupon face", () => {
  it("折扣显示几折，满减显示减免和门槛", () => {
    expect(
      couponFaceLabel({ kind: "percent", percentZhe: 8, amountCents: 0 }),
    ).toBe("8 折");
    expect(
      couponFaceLabel({ kind: "threshold", percentZhe: 0, amountCents: 2000 }),
    ).toBe("−¥20.00");
    expect(
      couponFaceHint({ kind: "threshold", thresholdCents: 15000, enabled: true }),
    ).toBe("满 ¥150.00");
    expect(
      couponFaceHint({ kind: "percent", thresholdCents: 0, enabled: false }),
    ).toBe("已停用");
  });

  it("次数文案区分不限和有上限", () => {
    expect(couponUsesLabel({ maxUses: 0, usedCount: 3 })).toContain("不限次数");
    expect(couponUsesLabel({ maxUses: 20, usedCount: 3 })).toBe("已用 3 / 20");
    expect(couponUsesRatio({ maxUses: 20, usedCount: 3 })).toBe(15);
  });
});

describe("dealLine", () => {
  it("带上张数和券码", () => {
    expect(dealLine({ productName: "Plus", quantity: 1 })).toBe("Plus");
    expect(dealLine({ productName: "Plus", quantity: 2, couponCode: "NEW8" })).toBe(
      "Plus ×2 · 券 NEW8",
    );
  });
});
