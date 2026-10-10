import { describe, expect, it } from "vitest";
import {
  beijingInputToUtcIso,
  beijingInputValue,
  correctionEventKey,
  correctionMissing,
  csvExportLinks,
  errorView,
  formatBeijing,
  formatFormula,
  formatNet,
  formatSignedYuan,
  formatYuan,
  isPaidAtInFuture,
  netEffectCents,
  parseLocked,
  parseNextSequence,
  parseYuanInput,
  reuseOrCreateKey,
  skippedAckKey,
  skippedKey,
  statusLabel,
} from "./admin-reconciliation-ui";

describe("金额格式", () => {
  it("千分位两位小数，取绝对值", () => {
    expect(formatYuan(123456789)).toBe("¥1,234,567.89");
    expect(formatYuan(-4000)).toBe("¥40.00");
    expect(formatYuan(0)).toBe("¥0.00");
  });

  it("分项带明确符号", () => {
    expect(formatSignedYuan(-4000)).toBe("−¥40.00");
    expect(formatSignedYuan(84000)).toBe("¥840.00");
  });

  it("净额用方向文案，不用负号，也不把负数显示成 0", () => {
    expect(formatNet(50000)).toBe("平台应付代理 ¥500.00");
    expect(formatNet(-30000)).toBe("代理应付平台 ¥300.00");
    expect(formatNet(0)).toBe("抵平 ¥0.00");
    expect(formatNet(-1)).not.toContain("-");
  });

  it("拆解公式", () => {
    expect(
      formatFormula({ storeEarningCents: 84000, adjustmentCents: -4000, drawDebtCents: 30000, netCents: 50000 }),
    ).toBe("商店收益 ¥840.00 ＋ 调整 −¥40.00 − 提卡 ¥300.00 ＝ 平台应付代理 ¥500.00");
  });

  it("提卡对净额是负向", () => {
    expect(netEffectCents("draw_item", 30000)).toBe(-30000);
    expect(netEffectCents("adjustment", -4000)).toBe(-4000);
  });

  it("元输入转分", () => {
    expect(parseYuanInput("-40")).toBe(-4000);
    expect(parseYuanInput("−1,234.5")).toBe(-123450);
    expect(parseYuanInput("0.07")).toBe(7);
    expect(parseYuanInput("1.234")).toBeNull();
    expect(parseYuanInput("abc")).toBeNull();
  });
});

describe("状态", () => {
  it("中文映射", () => {
    expect(statusLabel("draft")).toBe("待核对");
    expect(statusLabel("cleared")).toBe("已抵平结清");
    expect(statusLabel("correction_pending")).toBe("更正中");
    expect(statusLabel("weird")).toBe("未知状态");
  });
});

describe("北京时间", () => {
  it("datetime-local 按 +08:00 解析成 UTC", () => {
    expect(beijingInputToUtcIso("2026-10-10T17:00")).toBe("2026-10-10T09:00:00.000Z");
    expect(beijingInputToUtcIso("2026-10-11T03:30")).toBe("2026-10-10T19:30:00.000Z");
    expect(beijingInputToUtcIso("2026-02-30T10:00")).toBeNull();
    expect(beijingInputToUtcIso("")).toBeNull();
  });

  it("默认值是当前北京时间", () => {
    expect(beijingInputValue(new Date("2026-10-10T19:30:00Z"))).toBe("2026-10-11T03:30");
  });

  it("显示北京时间，兼容 SQLite 无时区写法", () => {
    expect(formatBeijing("2026-10-10T08:40:00.000Z")).toBe("2026-10-10 16:40");
    expect(formatBeijing("2026-10-10 08:40:00")).toBe("2026-10-10 16:40");
    expect(formatBeijing(null)).toBe("—");
  });
});

describe("幂等键", () => {
  const ids = ["a", "b", "c"];
  const make = () => ids.shift() || "z";

  it("同内容复用，内容变化换新", () => {
    const first = reuseOrCreateKey(undefined, "mark_paid", "batch1", { ref: "X", amount: 1 }, make);
    const retry = reuseOrCreateKey(first, "mark_paid", "batch1", { amount: 1, ref: "X" }, make);
    expect(retry.key).toBe(first.key);
    const changed = reuseOrCreateKey(first, "mark_paid", "batch1", { ref: "Y", amount: 1 }, make);
    expect(changed.key).not.toBe(first.key);
    const other = reuseOrCreateKey(first, "mark_paid", "batch2", { ref: "X", amount: 1 }, make);
    expect(other.key).not.toBe(first.key);
  });

  it("更正事件键", () => {
    expect(correctionEventKey(5, 7, "u")).toBe("manual:5:7:u");
  });
});

describe("错误映射", () => {
  it("预览阶段 SNAPSHOT_CHANGED 重新预览，批次阶段取消重建", () => {
    expect(errorView({ status: 409, code: "SNAPSHOT_CHANGED", stage: "create" }).action).toBe("repreview");
    expect(errorView({ status: 409, code: "SNAPSHOT_CHANGED", stage: "payment" }).action).toBe("cancel_rebuild");
  });

  it("5xx 与网络中断：显示编号，写操作标记结果未知", () => {
    const view = errorView({ status: 500, code: "INVALID_STATE", message: "SQLITE_BUSY", requestId: "req-1", stage: "payment" });
    expect(view.text).toContain("req-1");
    expect(view.text).not.toContain("SQLITE");
    expect(view.unknown).toBe(true);
    expect(errorView({ status: 0, stage: "create" }).unknown).toBe(true);
  });

  it("未知错误码不显示原始文本", () => {
    const view = errorView({ status: 409, code: "WHAT", message: "boom", requestId: "req-9", stage: "batch" });
    expect(view.text).toBe("系统出错，请把编号 req-9 发给开发");
  });

  it("序号冲突读出下一序号", () => {
    expect(parseNextSequence("下一序号是 3")).toBe(3);
    expect(errorView({ status: 409, code: "CORRECTION_SEQUENCE_CONFLICT", message: "下一序号是 3", stage: "correction" }).nextSequence).toBe(3);
    expect(errorView({ status: 409, code: "CORRECTION_EXCEEDS_EARNING", stage: "correction" }).text).toContain("有效收益");
  });
});

describe("其他", () => {
  it("跳过项 key 不重复", () => {
    expect(skippedKey({ code: "MISSING_SOURCE", orderNo: "A" }, 0)).not.toBe(skippedKey({ code: "MISSING_SOURCE", orderNo: "A" }, 1));
  });

  it("CSV 按 100 条一段", () => {
    expect(csvExportLinks(9, 50)).toHaveLength(1);
    const links = csvExportLinks(9, 250);
    expect(links).toHaveLength(3);
    expect(links[2].href).toContain("cursor=200");
    expect(links[0].href).toContain("format=csv");
  });
});

describe("付款时间不能晚于现在", () => {
  const now = new Date("2026-10-10T10:00:00Z");
  it("5 分钟内的时钟误差放行，超过则拒绝", () => {
    expect(isPaidAtInFuture("2026-10-10T10:04:59Z", now)).toBe(false);
    expect(isPaidAtInFuture("2026-10-10T10:05:01Z", now)).toBe(true);
    expect(isPaidAtInFuture("2026-10-09T10:00:00Z", now)).toBe(false);
    expect(isPaidAtInFuture(null, now)).toBe(false);
  });

  it("北京时间输入换算后比较", () => {
    // 北京 18:30 = UTC 10:30，晚于 UTC 10:00 + 5 分钟
    expect(isPaidAtInFuture(beijingInputToUtcIso("2026-10-10T18:30"), now)).toBe(true);
    expect(isPaidAtInFuture(beijingInputToUtcIso("2026-10-10T18:00"), now)).toBe(false);
  });

  it("后端对应错误显示中文提示", () => {
    const view = errorView({ status: 422, code: "PAYMENT_REFERENCE_REQUIRED", message: "付款时间不能晚于现在", stage: "payment" });
    expect(view.text).toBe("付款时间不能晚于现在");
    expect(errorView({ status: 422, code: "PAYMENT_REFERENCE_REQUIRED", message: "填写流水号", stage: "payment" }).text).toBe(
      "请填写流水号和付款时间",
    );
  });
});

describe("跳过项确认指纹", () => {
  const a = { code: "MISSING_SOURCE", orderNo: "A", amountCents: null };
  const b = { code: "LEDGER_MISMATCH", orderNo: "B", amountCents: 500 };
  it("顺序无关", () => {
    expect(skippedAckKey("pv", "t", [a, b])).toBe(skippedAckKey("pv", "t", [b, a]));
  });
  it("版本、截止、订单、原因、金额任一变化都变", () => {
    const base = skippedAckKey("pv", "t", [a, b]);
    expect(skippedAckKey("pv2", "t", [a, b])).not.toBe(base);
    expect(skippedAckKey("pv", "t2", [a, b])).not.toBe(base);
    expect(skippedAckKey("pv", "t", [a, { ...b, amountCents: 600 }])).not.toBe(base);
    expect(skippedAckKey("pv", "t", [a, { ...b, code: "MISSING_SOURCE" }])).not.toBe(base);
    expect(skippedAckKey("pv", "t", [a, { ...b, orderNo: "C" }])).not.toBe(base);
    expect(skippedAckKey("pv", "t", [a])).not.toBe(base);
  });
  it("金额未知与 0 不混淆", () => {
    expect(skippedAckKey("pv", "t", [{ ...a, amountCents: 0 }])).not.toBe(skippedAckKey("pv", "t", [a]));
  });
});

describe("锁定来源解析", () => {
  it("旧后端没有拆分字段：只保留合计，不崩溃", () => {
    const view = parseLocked({ locked: { itemCount: 3, netCents: 100 } });
    expect(view.legacyShape).toBe(true);
    expect(view.inBatch).toBeNull();
    expect(view.legacy).toBeNull();
    expect(view.total).toEqual({ itemCount: 3, netCents: 100 });
    expect(parseLocked({}).total).toBeNull();
  });
  it("两类同时出现", () => {
    const view = parseLocked({
      locked: { itemCount: 5, netCents: 300 },
      lockedInBatch: { itemCount: 3, netCents: 500, batchIds: [7, 9] },
      lockedLegacy: { itemCount: 2, netCents: -200, settlementNos: ["WK-1"] },
    });
    expect(view.legacyShape).toBe(false);
    expect(view.inBatch?.batchIds).toEqual([7, 9]);
    expect(view.legacy?.settlementNos).toEqual(["WK-1"]);
  });
  it("只有旧周结时没有 batchIds 可打开", () => {
    const view = parseLocked({ lockedInBatch: { itemCount: 0, netCents: 0 }, lockedLegacy: { itemCount: 1, netCents: 10, settlementNos: [] } });
    expect(view.inBatch).toBeNull();
    expect(view.legacy?.itemCount).toBe(1);
  });
  it("batchIds 里的脏值被忽略", () => {
    const view = parseLocked({ lockedInBatch: { itemCount: 1, netCents: 1, batchIds: [1, "x", -2, null, 3.5] } });
    expect(view.inBatch?.batchIds).toEqual([1]);
  });
});

describe("更正表单缺什么", () => {
  const ok = { hasItem: true, amountText: "-40", amountCents: -4000, reason: "退款", sequence: 1 };
  it("齐全时为空", () => {
    expect(correctionMissing(ok)).toEqual([]);
  });
  it("逐项提示", () => {
    expect(correctionMissing({ ...ok, hasItem: false })).toEqual(["请选择要更正的明细"]);
    expect(correctionMissing({ ...ok, reason: "  " })).toEqual(["请填写原因"]);
    expect(correctionMissing({ ...ok, amountText: "", amountCents: null })).toEqual(["请填写金额"]);
    expect(correctionMissing({ ...ok, amountText: "1.234", amountCents: null })).toEqual(["金额格式不对"]);
    expect(correctionMissing({ ...ok, amountText: "0", amountCents: 0 })).toEqual(["金额不能为 0"]);
    expect(correctionMissing({ hasItem: false, amountText: "", amountCents: null, reason: "", sequence: 1 })).toHaveLength(3);
  });
  it("超额更正文案", () => {
    expect(errorView({ status: 409, code: "CORRECTION_EXCEEDS_EARNING", stage: "correction" }).text).toBe(
      "更正金额超过这笔订单的有效收益，或订单已退款不能增加收益",
    );
  });
});