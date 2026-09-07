import { describe, expect, it } from "vitest";
import {
  normalizeStoreOrderKeyword,
  parseStoreOrderQuery,
  storeOrderQueryIsEmpty,
} from "./store-order-query-core";

describe("normalizeStoreOrderKeyword", () => {
  it("去掉首尾空格，并剥掉 LIKE 通配符", () => {
    expect(normalizeStoreOrderKeyword("  KS2026%_  ")).toBe("KS2026");
  });

  it("超过 64 个字就截断", () => {
    expect(normalizeStoreOrderKeyword("k".repeat(80))).toHaveLength(64);
  });
});

describe("parseStoreOrderQuery", () => {
  it("空条件保持为空", () => {
    expect(parseStoreOrderQuery({})).toEqual({
      q: "",
      agentId: null,
      payStatus: "",
      fulfillStatus: "",
    });
    expect(storeOrderQueryIsEmpty(parseStoreOrderQuery({}))).toBe(true);
  });

  it("只收下合法的代理 id 和状态", () => {
    const parsed = parseStoreOrderQuery({
      q: " onlyWjt ",
      agentId: "12",
      payStatus: "unpaid",
      fulfillStatus: "pending",
    });
    expect(parsed).toEqual({
      q: "onlyWjt",
      agentId: 12,
      payStatus: "unpaid",
      fulfillStatus: "pending",
    });
    expect(storeOrderQueryIsEmpty(parsed)).toBe(false);
  });

  it("乱填的状态和代理 id 当没选", () => {
    expect(
      parseStoreOrderQuery({
        agentId: "-1",
        payStatus: "drop-table",
        fulfillStatus: "issuing;--",
      }),
    ).toEqual({
      q: "",
      agentId: null,
      payStatus: "",
      fulfillStatus: "",
    });
  });
});
