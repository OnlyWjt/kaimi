import { describe, expect, it } from "vitest";
import {
  elapsedSeconds,
  formatWaitLabel,
  waitAnchor,
  type WaitClockStorage,
} from "./wait-clock";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: WaitClockStorage & { map: Map<string, string> } = {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
  return storage;
}

describe("waitAnchor", () => {
  it("重挂后读回同一个起算点，不会归零", () => {
    const storage = memoryStorage();
    const first = waitAnchor("KS1", storage, 1_000_000);
    // 模拟组件被重新挂载：8 秒后再取一次。
    const second = waitAnchor("KS1", storage, 1_008_000);
    expect(second).toBe(first);
    expect(elapsedSeconds(second, 1_008_000)).toBe(8);
  });

  it("不同订单各自计时", () => {
    const storage = memoryStorage();
    waitAnchor("KS1", storage, 1_000_000);
    const other = waitAnchor("KS2", storage, 1_005_000);
    expect(other).toBe(1_005_000);
    expect(elapsedSeconds(other, 1_005_000)).toBe(0);
  });

  it("存的起算点在未来说明不可信，重新锚一次", () => {
    const storage = memoryStorage({ "kaimi-order-wait:KS1": "9999999999999" });
    expect(waitAnchor("KS1", storage, 1_000_000)).toBe(1_000_000);
  });

  it("拿不到会话存储时退化成当前时间，不抛错", () => {
    expect(waitAnchor("KS1", null, 1_000_000)).toBe(1_000_000);
    const broken: WaitClockStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(waitAnchor("KS1", broken, 1_000_000)).toBe(1_000_000);
  });
});

describe("elapsedSeconds", () => {
  it("按秒向下取整", () => {
    expect(elapsedSeconds(1_000_000, 1_000_999)).toBe(0);
    expect(elapsedSeconds(1_000_000, 1_001_000)).toBe(1);
    expect(elapsedSeconds(1_000_000, 1_045_500)).toBe(45);
  });

  it("锚点缺失或时钟回拨时不出负数", () => {
    expect(elapsedSeconds(0, 1_000_000)).toBe(0);
    expect(elapsedSeconds(1_000_000, 990_000)).toBe(0);
  });
});

describe("formatWaitLabel", () => {
  it("一分钟以内只显示秒", () => {
    expect(formatWaitLabel(0)).toBe("0 秒");
    expect(formatWaitLabel(59)).toBe("59 秒");
  });

  it("超过一分钟改用分秒，整分不带零秒", () => {
    expect(formatWaitLabel(60)).toBe("1 分");
    expect(formatWaitLabel(95)).toBe("1 分 35 秒");
    expect(formatWaitLabel(3600)).toBe("60 分");
  });
});
