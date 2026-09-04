import { describe, expect, it } from "vitest";
import { issueIdempotencyKey } from "./issue-keys";
import {
  FULFILLMENT_RETRY_DELAYS_MS,
  fulfillmentRetryDelayMs,
  fulfillmentRetryExhausted,
} from "./retry-policy";

describe("fulfillmentRetryExhausted", () => {
  it("八次真失败才算用尽预算", () => {
    expect(fulfillmentRetryExhausted(7)).toBe(false);
    expect(fulfillmentRetryExhausted(8)).toBe(true);
  });

  // 卡台一次只回一张时，5 张的单以前会把 attempt 1-5 全烧掉，买家白等 44 分钟。
  it("只有 partial 的单一次预算都没花", () => {
    expect(fulfillmentRetryExhausted(0)).toBe(false);
    expect(fulfillmentRetryDelayMs(0)).toBe(0);
  });
});

describe("fulfillmentRetryDelayMs", () => {
  it("退避按真失败次数走，不按 attempt_no", () => {
    expect(fulfillmentRetryDelayMs(1)).toBe(60_000);
    expect(fulfillmentRetryDelayMs(2)).toBe(3 * 60_000);
  });

  it("越界回落到最后一档", () => {
    const last = FULFILLMENT_RETRY_DELAYS_MS[FULFILLMENT_RETRY_DELAYS_MS.length - 1];
    expect(fulfillmentRetryDelayMs(99)).toBe(last);
    expect(fulfillmentRetryDelayMs(-3)).toBe(0);
  });
});

describe("issueIdempotencyKey", () => {
  it("一张都还没入库时就是原键，超时重试要能被上游重放", () => {
    expect(issueIdempotencyKey("k", 0)).toBe("k");
    expect(issueIdempotencyKey("k", 0, 0)).toBe("k");
  });

  it("已经入库几张就换键，否则卡台重放上一批", () => {
    expect(issueIdempotencyKey("k", 3)).toBe("k-r3");
    expect(issueIdempotencyKey("k", 3)).toBe(issueIdempotencyKey("k", 3));
  });

  // 零进展的那次要是继续用同一个键，上游缓存了空响应就永远发不出剩下的卡。
  it("卡台明确回过空之后换键，进展为零也不会卡死", () => {
    expect(issueIdempotencyKey("k", 0, 1)).toBe("k-e1");
    expect(issueIdempotencyKey("k", 0, 2)).toBe("k-e2");
    expect(issueIdempotencyKey("k", 0, 1)).not.toBe(issueIdempotencyKey("k", 0, 0));
  });

  it("已入库几张之后又收到空响应，同样要换键", () => {
    expect(issueIdempotencyKey("k", 3, 1)).toBe("k-r3-e1");
    expect(issueIdempotencyKey("k", 3, 1)).not.toBe(issueIdempotencyKey("k", 3, 0));
  });
});
