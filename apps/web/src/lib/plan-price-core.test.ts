import { describe, expect, it } from "vitest";
import {
  isOverMaxRetailPrice,
  maxRetailPriceError,
  resolveMaxRetailPriceCents,
  retailPriceError,
  retailPriceRangeHint,
} from "./plan-price-core";

describe("resolveMaxRetailPriceCents", () => {
  it("null 和 0 都当不限价", () => {
    expect(resolveMaxRetailPriceCents(null)).toBe(null);
    expect(resolveMaxRetailPriceCents(undefined)).toBe(null);
    expect(resolveMaxRetailPriceCents(0)).toBe(null);
    expect(resolveMaxRetailPriceCents(-1)).toBe(null);
  });

  it("正数原样返回", () => {
    expect(resolveMaxRetailPriceCents(9900)).toBe(9900);
  });
});

describe("retailPriceError", () => {
  const bounds = { costPriceCents: 5000, maxRetailPriceCents: 9900 };

  it("贴着上下界都放行", () => {
    expect(retailPriceError(5000, bounds)).toBe(null);
    expect(retailPriceError(9900, bounds)).toBe(null);
  });

  it("差一分低于成本价就拦，提示按元", () => {
    expect(retailPriceError(4999, bounds)).toBe("零售价不能低于代理成本价 ¥50.00");
  });

  it("差一分高于限价就拦，提示按元", () => {
    expect(retailPriceError(9901, bounds)).toBe("零售价不能高于平台限价 ¥99.00");
  });

  it("没设限价时只管下界", () => {
    expect(retailPriceError(1155_00, { costPriceCents: 5000 })).toBe(null);
    expect(retailPriceError(1155_00, { costPriceCents: 5000, maxRetailPriceCents: 0 })).toBe(
      null,
    );
    expect(retailPriceError(4999, { costPriceCents: 5000 })).toBe(
      "零售价不能低于代理成本价 ¥50.00",
    );
  });
});

describe("maxRetailPriceError", () => {
  it("限价不低于成本价就放行", () => {
    expect(maxRetailPriceError(9900, 5000)).toBe(null);
    expect(maxRetailPriceError(5000, 5000)).toBe(null);
    expect(maxRetailPriceError(null, 5000)).toBe(null);
    expect(maxRetailPriceError(0, 5000)).toBe(null);
  });

  it("限价低于成本价要拦下来", () => {
    expect(maxRetailPriceError(4999, 5000)).toBe(
      "限价 ¥49.99 低于成本价 ¥50.00，代理将无法定价",
    );
  });
});

describe("retailPriceRangeHint", () => {
  it("有无上限给不同文案", () => {
    expect(retailPriceRangeHint({ costPriceCents: 5000 })).toBe("不低于 ¥50.00");
    expect(
      retailPriceRangeHint({ costPriceCents: 5000, maxRetailPriceCents: 9900 }),
    ).toBe("¥50.00 ~ ¥99.00");
  });
});

describe("isOverMaxRetailPrice", () => {
  it("只有确实超过才算超", () => {
    expect(isOverMaxRetailPrice(9901, 9900)).toBe(true);
    expect(isOverMaxRetailPrice(9900, 9900)).toBe(false);
    expect(isOverMaxRetailPrice(115500, null)).toBe(false);
  });
});
