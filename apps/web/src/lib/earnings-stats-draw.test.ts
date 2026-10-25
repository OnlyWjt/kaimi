import { describe, expect, it } from "vitest";
import { buildDrawStats, buildEarningsStats, buildPeriodRows, statsBuckets } from "./earnings-stats-core";

const item = {
  agentId: 7,
  agentName: "提卡代理",
  // 北京时间 10 月 24 日上午
  createdAt: "2026-10-24T02:00:00.000Z",
  amountCents: 9000,
  upstreamCostCents: 7000,
  status: "unsettled",
};

describe("buildDrawStats", () => {
  it("提卡毛利 = 提卡价 − 上游成本，没结算的也算，作废的不算", () => {
    const { totals } = buildDrawStats({
      grain: "day",
      draws: [
        item,
        { ...item, status: "settled" },
        { ...item, status: "void" },
      ],
    });
    expect(totals).toEqual({
      itemCount: 2,
      amountCents: 18000,
      upstreamCents: 14000,
      profitCents: 4000,
      profitUnknownCount: 0,
      unsettledCents: 9000,
      settledCents: 9000,
      voidCount: 1,
    });
  });

  it("没有上游成本的不进毛利，单独数出来", () => {
    const { totals } = buildDrawStats({ grain: "day", draws: [item, { ...item, upstreamCostCents: null }] });
    expect(totals).toMatchObject({ itemCount: 2, amountCents: 18000, profitCents: 2000, profitUnknownCount: 1 });
  });

  it("按北京日期切天、按代理分开", () => {
    const { series, byAgent } = buildDrawStats({
      grain: "day",
      draws: [
        item,
        // UTC 10 月 24 日 17 点 = 北京 10 月 25 日凌晨
        { ...item, createdAt: "2026-10-24T17:00:00.000Z" },
        { ...item, agentId: 8, agentName: "另一个代理" },
      ],
    });
    expect(series.map((row) => [row.bucket, row.itemCount])).toEqual([
      ["2026-10-24", 2],
      ["2026-10-25", 1],
    ]);
    expect(byAgent.map((row) => [row.agentId, row.profitCents])).toEqual([
      [7, 4000],
      [8, 2000],
    ]);
  });
});

describe("statsBuckets", () => {
  it("天、周、月都列全，含首尾", () => {
    expect(statsBuckets("2026-10-19", "2026-10-25", "day")).toHaveLength(7);
    expect(statsBuckets("2026-10-22", "2026-11-03", "week")).toEqual(["2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(statsBuckets("2026-11-15", "2027-02-01", "month")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("范围太长或倒过来返回空", () => {
    expect(statsBuckets("2020-01-01", "2026-10-25", "day")).toEqual([]);
    expect(statsBuckets("2026-10-25", "2026-10-24", "day")).toEqual([]);
  });
});

describe("buildPeriodRows", () => {
  it("店铺毛利和提卡毛利并排，没单的日子记 0，最新的在前", () => {
    const store = buildEarningsStats({
      grain: "day",
      earnings: [
        {
          agentId: 1,
          agentName: "店铺代理",
          confirmedAt: "2026-10-23T03:00:00.000Z",
          grossCents: 15000,
          costCents: 12000,
          paymentFeeCents: 150,
          upstreamCents: 10000,
          platformProfitCents: 1900,
          earningCents: 2850,
          status: "pending",
        },
      ],
      adjustments: [],
    });
    const draw = buildDrawStats({ grain: "day", draws: [item] });
    const rows = buildPeriodRows({
      grain: "day",
      startYmd: "2026-10-22",
      endYmd: "2026-10-24",
      store: store.series,
      draw: draw.series,
    });
    expect(rows.map((row) => [row.bucket, row.storeProfitCents, row.drawProfitCents, row.totalProfitCents])).toEqual([
      ["2026-10-24", 0, 2000, 2000],
      ["2026-10-23", 1900, 0, 1900],
      ["2026-10-22", 0, 0, 0],
    ]);
    expect(rows[1]).toMatchObject({ storeOrderCount: 1, drawItemCount: 0, label: "2026-10-23" });
  });
});
