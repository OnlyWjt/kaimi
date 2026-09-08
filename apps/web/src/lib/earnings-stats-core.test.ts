import { describe, expect, it } from "vitest";
import {
  beijingDateRangeIso,
  buildEarningsStats,
  buildOrderPipeline,
  parseStatsGrain,
  statsBucketKey,
  statsBucketLabel,
} from "./earnings-stats-core";

const earning = {
  agentId: 1,
  agentName: "onlyWjt",
  confirmedAt: "2026-09-08T02:00:00.000Z",
  grossCents: 15000,
  costCents: 12000,
  paymentFeeCents: 150,
  earningCents: 2850,
  status: "pending",
};

describe("beijingDateRangeIso", () => {
  it("把北京日历日换成 UTC 边界，含当天头尾", () => {
    const range = beijingDateRangeIso("2026-09-08", "2026-09-08");
    expect(range.start).toBe("2026-09-07T16:00:00.000Z");
    expect(range.end).toBe("2026-09-08T15:59:59.999Z");
  });

  it("开始晚于结束会拒绝", () => {
    expect(() => beijingDateRangeIso("2026-09-09", "2026-09-08")).toThrow(
      "开始日期不能晚于结束日期",
    );
  });
});

describe("statsBucketKey", () => {
  it("北京时间 9 月 8 日凌晨落在 9 月 8 日，不落到 UTC 的 9 月 7 日", () => {
    expect(statsBucketKey("2026-09-07T16:30:00.000Z", "day")).toBe("2026-09-08");
  });

  it("周按北京周一切开", () => {
    expect(statsBucketKey("2026-09-08T02:00:00.000Z", "week")).toBe("2026-09-07");
    expect(statsBucketKey("2026-09-08T02:00:00.000Z", "month")).toBe("2026-09");
  });
});

describe("statsBucketLabel", () => {
  it("月和周用中文标签", () => {
    expect(statsBucketLabel("2026-09", "month")).toBe("2026年9月");
    expect(statsBucketLabel("2026-09-07", "week")).toBe("2026-09-07 当周");
  });
});

describe("parseStatsGrain", () => {
  it("认不出的粒度按天", () => {
    expect(parseStatsGrain("week")).toBe("week");
    expect(parseStatsGrain("nope")).toBe("day");
  });
});

describe("buildEarningsStats", () => {
  it("平台收益是成本，代理收益是佣金，销售额能加回去", () => {
    const stats = buildEarningsStats({
      grain: "day",
      earnings: [earning],
      adjustments: [],
    });
    expect(stats.totals).toMatchObject({
      orderCount: 1,
      grossCents: 15000,
      platformCents: 12000,
      agentCents: 2850,
      feeCents: 150,
      pendingCents: 2850,
    });
    expect(
      stats.totals.platformCents + stats.totals.agentCents + stats.totals.feeCents,
    ).toBe(15000);
  });

  it("已冲正的单不进你和代理的赚", () => {
    const stats = buildEarningsStats({
      grain: "day",
      earnings: [{ ...earning, status: "reversed" }],
      adjustments: [],
    });
    expect(stats.totals.orderCount).toBe(0);
    expect(stats.totals.platformCents).toBe(0);
    expect(stats.totals.agentCents).toBe(0);
  });

  it("退款调整只动代理收益，不动平台成本", () => {
    const stats = buildEarningsStats({
      grain: "day",
      earnings: [{ ...earning, status: "settled" }],
      adjustments: [
        {
          agentId: 1,
          agentName: "onlyWjt",
          createdAt: "2026-09-08T04:00:00.000Z",
          amountCents: -2850,
          status: "pending",
        },
      ],
    });
    expect(stats.totals.platformCents).toBe(12000);
    expect(stats.totals.agentCents).toBe(0);
    expect(stats.totals.pendingCents).toBe(-2850);
    expect(stats.totals.settledCents).toBe(2850);
  });

  it("按渠道和套餐拆开", () => {
    const stats = buildEarningsStats({
      grain: "day",
      earnings: [
        { ...earning, paymentChannel: "alipay", planName: "Plus" },
        {
          ...earning,
          agentId: 2,
          agentName: "why",
          paymentChannel: "wxpay",
          planName: "Pro",
          grossCents: 20000,
          costCents: 16000,
          paymentFeeCents: 200,
          earningCents: 3800,
        },
      ],
      adjustments: [],
    });
    expect(stats.byChannel.map((row) => row.label)).toEqual(["微信支付", "支付宝"]);
    expect(stats.byPlan[0]?.label).toBe("Pro");
  });
});

describe("buildOrderPipeline", () => {
  it("把未支付、卡住和待核手续费单独数出来", () => {
    const pipeline = buildOrderPipeline([
      { payStatus: "unpaid", fulfillStatus: "pending", feeReconcileStatus: "pending", grossCents: 1000 },
      { payStatus: "paid", fulfillStatus: "issuing", feeReconcileStatus: "manual_review", grossCents: 2000 },
      { payStatus: "paid", fulfillStatus: "delivered", feeReconcileStatus: "confirmed", grossCents: 3000 },
    ]);
    expect(pipeline.unpaidCount).toBe(1);
    expect(pipeline.stuckCount).toBe(1);
    expect(pipeline.stuckCents).toBe(2000);
    expect(pipeline.deliveredCount).toBe(1);
    expect(pipeline.feeReviewCount).toBe(1);
  });
});
