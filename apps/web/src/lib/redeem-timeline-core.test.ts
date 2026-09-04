import { describe, expect, it } from "vitest";
import {
  coarseStageIndex,
  isUpstreamTerminal,
  parseRedeemResult,
  resultOrderStatus,
  timelineEventKey,
} from "./redeem-timeline-core";
import { adminStatusLabel, publicStatusLabel } from "./status-labels";

/** 卡台文档里那个形状：订单字段包在 order 里，事件在顶层 events。 */
function nestedPayload() {
  return {
    order: {
      status: "completed",
      stage: "done",
      message: "Stripe 已确认扣款（payment_status=paid）；套餐核验后置。",
      account_email: "Liam.Jones1376@mail.com",
      card_last_four: "4242",
    },
    events: [
      {
        step: "credential_check",
        category: "pending",
        created_at: "2026-09-04T06:55:43Z",
        public_message: "订单已创建并进入安全队列",
      },
      {
        step: "completed",
        category: "success",
        created_at: "2026-09-04T06:56:28Z",
        public_message: "Stripe 已确认扣款（payment_status=paid）；套餐核验后置。",
      },
    ],
  };
}

describe("parseRedeemResult 订单字段", () => {
  it("从 order 里读状态、阶段、账号和卡尾号", () => {
    const { order } = parseRedeemResult(nestedPayload());
    expect(order.status).toBe("completed");
    expect(order.stage).toBe("done");
    expect(order.accountEmail).toBe("liam.jones1376@mail.com");
    expect(order.cardLastFour).toBe("4242");
    expect(order.message).toContain("Stripe");
  });

  it("扁平结构也能读出来", () => {
    const { order, events } = parseRedeemResult({
      status: "queued",
      stage: "dispatch",
      message: "已受理",
      account_email: "a@b.com",
      events: [{ step: "queued", created_at: "2026-09-04T06:00:00Z" }],
    });
    expect(order.status).toBe("queued");
    expect(order.stage).toBe("dispatch");
    expect(order.accountEmail).toBe("a@b.com");
    expect(events).toHaveLength(1);
  });

  it("data 包裹一层也能读出来", () => {
    const { order, events } = parseRedeemResult({
      code: 0,
      data: {
        order: { status: "review", stage: "payment" },
        events: [{ step: "payment", category: "review" }],
      },
    });
    expect(order.status).toBe("review");
    expect(order.stage).toBe("payment");
    expect(events).toHaveLength(1);
  });

  it("卡尾号只认四位数字，否则从卡号末尾取", () => {
    expect(parseRedeemResult({ order: { card_last_four: "••42" } }).order.cardLastFour).toBe("");
    expect(
      parseRedeemResult({ order: { card_number: "5555 4444 3333 1234" } }).order.cardLastFour,
    ).toBe("1234");
  });

  it("字段缺失、改名、多出来都不抛错", () => {
    expect(parseRedeemResult(null).order.status).toBe("");
    expect(parseRedeemResult("nonsense").events).toEqual([]);
    const { order, events } = parseRedeemResult({
      order: { status: "running", unexpected_field: { deep: 1 } },
      events: [{ step: "pricing", extra: [1, 2, 3] }],
    });
    expect(order.status).toBe("running");
    expect(order.message).toBe("");
    expect(events[0]!.message).toBe("");
    expect(events[0]!.at).toBe("");
  });

  it("events 为空数组或不是数组时给空时间线", () => {
    expect(parseRedeemResult({ order: { status: "queued" }, events: [] }).events).toEqual([]);
    expect(parseRedeemResult({ events: "boom" }).events).toEqual([]);
  });

  it("public_message 缺失时退到 to_status", () => {
    const { events } = parseRedeemResult({
      events: [{ step: "payment", to_status: "paid" }],
    });
    expect(events[0]!.message).toBe("paid");
  });

  it("按 created_at 升序排，时间缺失时保持上游顺序", () => {
    const { events } = parseRedeemResult({
      events: [
        { step: "completed", created_at: "2026-09-04T06:56:28Z" },
        { step: "queued", created_at: "2026-09-04T06:55:43Z" },
        { step: "orphan" },
      ],
    });
    expect(events.map((e) => e.step)).toEqual(["queued", "completed", "orphan"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("resultOrderStatus", () => {
  it("order.status 优先于顶层 status", () => {
    expect(resultOrderStatus({ status: "pending", order: { status: "completed" } })).toBe(
      "completed",
    );
  });

  it("order 里没有状态时才回落到顶层和 data", () => {
    expect(resultOrderStatus({ order: { stage: "payment" }, status: "Running" })).toBe("running");
    expect(resultOrderStatus({ data: { status: "declined" } })).toBe("declined");
    expect(resultOrderStatus({})).toBe("");
  });
});

describe("timelineEventKey 去重", () => {
  it("重复轮询同一批事件得到同一组键", () => {
    const first = parseRedeemResult(nestedPayload()).events.map((e) => e.key);
    const second = parseRedeemResult(nestedPayload()).events.map((e) => e.key);
    expect(second).toEqual(first);
  });

  it("下一轮多出一条事件时，旧的键不变，只多一个新键", () => {
    const before = parseRedeemResult(nestedPayload()).events.map((e) => e.key);
    const grown = nestedPayload();
    grown.events.splice(1, 0, {
      step: "checkout",
      category: "success",
      created_at: "2026-09-04T06:56:01Z",
      public_message: "卡片资金已确认到账",
    });
    const after = parseRedeemResult(grown).events.map((e) => e.key);
    expect(after).toHaveLength(3);
    expect(new Set(after)).toEqual(new Set([...before, after[1]!]));
  });

  it("上游给了 id 就用 id，同一条事件改了文案也还是同一条", () => {
    const a = timelineEventKey({ id: 9001, step: "payment", created_at: "t1" }, 0);
    const b = timelineEventKey({ id: 9001, step: "payment", created_at: "t2" }, 5);
    expect(a).toBe("id:9001");
    expect(b).toBe(a);
  });

  it("同一步骤在不同时间发生算两条", () => {
    const a = timelineEventKey({ step: "credential_check", created_at: "t1" }, 0);
    const b = timelineEventKey({ step: "credential_check", created_at: "t2" }, 1);
    expect(a).not.toBe(b);
  });

  it("三个字段全空时退化成下标，不会把整批并成一条", () => {
    const { events } = parseRedeemResult({ events: [{}, {}, {}] });
    expect(events.map((e) => e.key)).toEqual(["i:0", "i:1", "i:2"]);
  });

  it("同一批里键撞了只留先到的一条", () => {
    const { events } = parseRedeemResult({
      events: [
        { step: "queued", category: "pending", created_at: "t1", public_message: "先到" },
        { step: "queued", category: "pending", created_at: "t1", public_message: "后到" },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe("先到");
  });
});

describe("步骤与分类的文案兜底", () => {
  it("认识的键翻成中文", () => {
    expect(publicStatusLabel("credential_check", "redeemStep")).toBe("凭证校验");
    expect(publicStatusLabel("checkout", "redeemStep")).toBe("开卡/绑卡");
    expect(publicStatusLabel("review", "redeemEvent")).toBe("待核对");
    expect(publicStatusLabel("done", "redeemStage")).toBe("开通");
  });

  it("没见过的步骤和分类对客户退化成中文，绝不露原始英文", () => {
    expect(publicStatusLabel("kyc_retry", "redeemStep")).toBe("处理中");
    expect(publicStatusLabel("throttled", "redeemEvent")).toBe("处理中");
    expect(publicStatusLabel("awaiting_3ds", "redeemStage")).toBe("处理中");
    expect(publicStatusLabel("", "redeemStep")).toBe("—");
  });

  it("管理员那边保留原值，那串英文是排查线索", () => {
    expect(adminStatusLabel("kyc_retry", "redeemStep")).toBe("kyc_retry");
    expect(adminStatusLabel("credential_check", "redeemStep")).toBe("凭证校验");
  });
});

describe("coarseStageIndex 粗粒度四段", () => {
  it("completed 走满四段", () => {
    expect(coarseStageIndex({ status: "completed", stage: "done" })).toBe(3);
  });

  it("按 stage 推进：资金 → 支付", () => {
    expect(coarseStageIndex({ status: "running", stage: "await_funds" })).toBe(1);
    expect(coarseStageIndex({ status: "running", stage: "card_open" })).toBe(1);
    expect(coarseStageIndex({ status: "running", stage: "dispatch" })).toBe(2);
    expect(coarseStageIndex({ status: "running", stage: "subscription" })).toBe(2);
  });

  it("失败停在走到过的最远一步，不缩回起点", () => {
    expect(coarseStageIndex({ status: "declined", stage: "payment" })).toBe(2);
    expect(coarseStageIndex({ status: "failed_precharge", stage: "card_open" })).toBe(1);
    expect(coarseStageIndex({ status: "cancelled", stage: "queued" })).toBe(0);
  });

  it("stage 认不出来时退回看已经出现过的步骤", () => {
    expect(coarseStageIndex({ status: "running", stage: "", steps: [] })).toBe(0);
    expect(coarseStageIndex({ status: "running", stage: "", steps: ["queued"] })).toBe(1);
    expect(
      coarseStageIndex({ status: "running", stage: "", steps: ["queued", "checkout"] }),
    ).toBe(2);
  });

  it("什么都没有时停在第一段", () => {
    expect(coarseStageIndex({})).toBe(0);
  });
});

describe("isUpstreamTerminal", () => {
  it("review 和 pending 不是终态，还要接着查", () => {
    expect(isUpstreamTerminal("review")).toBe(false);
    expect(isUpstreamTerminal("pending")).toBe(false);
    expect(isUpstreamTerminal("queued")).toBe(false);
  });

  it("文档里那五个才是终态", () => {
    for (const status of ["completed", "declined", "failed_precharge", "cancelled", "failed"]) {
      expect(isUpstreamTerminal(status)).toBe(true);
    }
  });
});
