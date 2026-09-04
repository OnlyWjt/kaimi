import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_REDEEM_LIMIT,
  HARD_MAX_BATCH_REDEEM_LIMIT,
  batchRowIsCommitted,
  batchRowStateFromOrder,
  batchSubmitFailureState,
  canRetryBatchRow,
  clampRedeemCodes,
  mapPool,
  normalizeBatchRedeemLimit,
  parseRedeemCodes,
  takeRedeemCodes,
} from "./recharge-batch-core";

describe("parseRedeemCodes", () => {
  it("换行、空格、制表、逗号、分号（含全角）都当分隔符", () => {
    expect(
      parseRedeemCodes("AAAAAA\nBBBBBB\tCCCCCC DDDDDD,EEEEEE;FFFFFF，GGGGGG；HHHHHH、IIIIII"),
    ).toEqual([
      "AAAAAA",
      "BBBBBB",
      "CCCCCC",
      "DDDDDD",
      "EEEEEE",
      "FFFFFF",
      "GGGGGG",
      "HHHHHH",
      "IIIIII",
    ]);
  });

  it("统一大写，同一张卡不同写法只算一张", () => {
    expect(parseRedeemCodes("cdk-abc123\nCDK-ABC123\n  cdk-Abc123  ")).toEqual([
      "CDK-ABC123",
    ]);
  });

  it("去重后保留第一次出现的顺序", () => {
    expect(parseRedeemCodes("BBBBBB AAAAAA BBBBBB CCCCCC AAAAAA")).toEqual([
      "BBBBBB",
      "AAAAAA",
      "CCCCCC",
    ]);
  });

  it("短于 6 位的碎片和空串一律丢掉", () => {
    expect(parseRedeemCodes("AAAAAA , , 卡密: BBBBBB\n\n\nX Y ZZ 12345")).toEqual([
      "AAAAAA",
      "BBBBBB",
    ]);
    expect(parseRedeemCodes("")).toEqual([]);
    expect(parseRedeemCodes("   \n  ")).toEqual([]);
    // 6 位是卡台 preview 的下限，正好 6 位要收。
    expect(parseRedeemCodes("123456")).toEqual(["123456"]);
  });
});

describe("normalizeBatchRedeemLimit", () => {
  it("空值、非数字、小于 1 都回落到默认 20", () => {
    expect(normalizeBatchRedeemLimit("")).toBe(DEFAULT_BATCH_REDEEM_LIMIT);
    expect(normalizeBatchRedeemLimit(undefined)).toBe(DEFAULT_BATCH_REDEEM_LIMIT);
    expect(normalizeBatchRedeemLimit("abc")).toBe(DEFAULT_BATCH_REDEEM_LIMIT);
    expect(normalizeBatchRedeemLimit(0)).toBe(DEFAULT_BATCH_REDEEM_LIMIT);
    expect(normalizeBatchRedeemLimit(-8)).toBe(DEFAULT_BATCH_REDEEM_LIMIT);
  });

  it("按硬上限夹住，小数向下取整", () => {
    expect(normalizeBatchRedeemLimit("30")).toBe(30);
    expect(normalizeBatchRedeemLimit(9.7)).toBe(9);
    expect(normalizeBatchRedeemLimit(5000)).toBe(HARD_MAX_BATCH_REDEEM_LIMIT);
  });
});

describe("takeRedeemCodes", () => {
  it("超过上限只收前 N 张，多出来的条数要报出来", () => {
    const raw = Array.from({ length: 25 }, (_, i) => `CODE${String(i).padStart(4, "0")}`).join("\n");
    const taken = takeRedeemCodes(raw, 20);
    expect(taken.limit).toBe(20);
    expect(taken.codes).toHaveLength(20);
    expect(taken.dropped).toBe(5);
    expect(taken.codes[0]).toBe("CODE0000");
    expect(taken.codes[19]).toBe("CODE0019");
  });

  it("没超上限时 dropped 为 0", () => {
    const taken = takeRedeemCodes("AAAAAA BBBBBB", 20);
    expect(taken.codes).toEqual(["AAAAAA", "BBBBBB"]);
    expect(taken.dropped).toBe(0);
  });

  it("上限本身也走 normalize，后台配 999 也夹到硬上限", () => {
    const raw = Array.from({ length: 60 }, (_, i) => `CODE${String(i).padStart(4, "0")}`).join(",");
    expect(takeRedeemCodes(raw, 999).codes).toHaveLength(HARD_MAX_BATCH_REDEEM_LIMIT);
  });
});

describe("clampRedeemCodes", () => {
  it("接口收到的数组同样去重、规范化并夹上限", () => {
    const clamped = clampRedeemCodes(
      ["aaaaaa", "AAAAAA", " bbbbbb ", "no", "CCCCCC"],
      2,
    );
    expect(clamped.codes).toEqual(["AAAAAA", "BBBBBB"]);
    expect(clamped.dropped).toBe(1);
  });

  it("不是数组就当空批", () => {
    expect(clampRedeemCodes("AAAAAA", 20).codes).toEqual([]);
    expect(clampRedeemCodes(null, 20).codes).toEqual([]);
  });
});

describe("batchRowStateFromOrder", () => {
  it("success / skipped / fulfilled 都算成功", () => {
    expect(batchRowStateFromOrder("success")).toBe("success");
    expect(batchRowStateFromOrder("skipped")).toBe("success");
    expect(batchRowStateFromOrder("fulfilled")).toBe("success");
  });

  it("failed 是确定失败，unknown 是结果未知，两者不能混", () => {
    expect(batchRowStateFromOrder("failed")).toBe("failed");
    expect(batchRowStateFromOrder("unknown")).toBe("unknown");
  });

  it("没跑完和认不出来的状态都当进行中，绝不当成失败", () => {
    expect(batchRowStateFromOrder("pending")).toBe("running");
    expect(batchRowStateFromOrder("processing")).toBe("running");
    expect(batchRowStateFromOrder("submitted")).toBe("running");
    expect(batchRowStateFromOrder("preparing")).toBe("running");
    expect(batchRowStateFromOrder("")).toBe("running");
    expect(batchRowStateFromOrder("something_new_upstream")).toBe("running");
  });
});

describe("canRetryBatchRow", () => {
  it("只有确定失败的行给重试", () => {
    expect(canRetryBatchRow("failed")).toBe(true);
    expect(canRetryBatchRow("invalid")).toBe(true);
  });

  it("结果未知绝不给重试：卡台可能已经扣过费，重提等于扣两次", () => {
    expect(canRetryBatchRow("unknown")).toBe(false);
  });

  it("还在跑和已经成功的行也不给重试", () => {
    expect(canRetryBatchRow("pending")).toBe(false);
    expect(canRetryBatchRow("checking")).toBe(false);
    expect(canRetryBatchRow("ready")).toBe(false);
    expect(canRetryBatchRow("submitting")).toBe(false);
    expect(canRetryBatchRow("running")).toBe(false);
    expect(canRetryBatchRow("success")).toBe(false);
  });
});

describe("batchRowIsCommitted", () => {
  it("已经交给卡台的行不能被重新校验冲掉", () => {
    expect(batchRowIsCommitted("submitting")).toBe(true);
    expect(batchRowIsCommitted("running")).toBe(true);
    expect(batchRowIsCommitted("success")).toBe(true);
    expect(batchRowIsCommitted("unknown")).toBe(true);
  });

  it("还没提交的行可以重新校验", () => {
    expect(batchRowIsCommitted("pending")).toBe(false);
    expect(batchRowIsCommitted("checking")).toBe(false);
    expect(batchRowIsCommitted("ready")).toBe(false);
    expect(batchRowIsCommitted("invalid")).toBe(false);
    expect(batchRowIsCommitted("failed")).toBe(false);
  });

  it("可重试和已托付是互斥的：没有哪一行既能重试又不许动", () => {
    const states = [
      "pending",
      "checking",
      "invalid",
      "ready",
      "submitting",
      "running",
      "success",
      "failed",
      "unknown",
    ] as const;
    for (const state of states) {
      expect(canRetryBatchRow(state) && batchRowIsCommitted(state)).toBe(false);
    }
  });
});

describe("batchSubmitFailureState", () => {
  it("服务端逐张回了结果就是确定失败，可以重试", () => {
    expect(batchSubmitFailureState({ status: 200, hadResults: true })).toBe("failed");
    expect(batchSubmitFailureState({ status: 500, hadResults: true })).toBe("failed");
  });

  it("建单之前就被挡下来的（参数、鉴权、限流）算确定失败", () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(batchSubmitFailureState({ status, hadResults: false })).toBe("failed");
    }
  });

  it("断网、超时、5xx 都算结果未知，只能去查不能重提", () => {
    expect(batchSubmitFailureState({ status: 0, hadResults: false })).toBe("unknown");
    expect(batchSubmitFailureState({ status: 500, hadResults: false })).toBe("unknown");
    expect(batchSubmitFailureState({ status: 502, hadResults: false })).toBe("unknown");
    expect(batchSubmitFailureState({ status: 504, hadResults: false })).toBe("unknown");
  });

  it("这两条串起来：未知的行拿不到重试按钮", () => {
    const timedOut = batchSubmitFailureState({ status: 0, hadResults: false });
    expect(canRetryBatchRow(timedOut)).toBe(false);
    const rejected = batchSubmitFailureState({ status: 429, hadResults: false });
    expect(canRetryBatchRow(rejected)).toBe(true);
  });
});

describe("mapPool", () => {
  it("保持入参顺序返回结果", async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("并发不超过给定宽度", async () => {
    let running = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("空批不会卡住", async () => {
    expect(await mapPool([], 6, async () => 1)).toEqual([]);
  });
});
