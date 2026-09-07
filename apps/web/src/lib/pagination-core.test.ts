import { describe, expect, it } from "vitest";
import {
  hasNextPage,
  normalizePage,
  normalizePageSize,
  pageCount,
  pageLabel,
} from "./pagination-core";

describe("normalizePage", () => {
  it("空值和垃圾值都回到第 1 页", () => {
    expect(normalizePage(undefined)).toBe(1);
    expect(normalizePage("")).toBe(1);
    expect(normalizePage("abc")).toBe(1);
    expect(normalizePage(0)).toBe(1);
    expect(normalizePage(-3)).toBe(1);
  });

  it("正常页码原样返回", () => {
    expect(normalizePage("3")).toBe(3);
    expect(normalizePage(3.7)).toBe(3);
  });
});

describe("normalizePageSize", () => {
  it("空值用默认值，超出硬上限就夹住", () => {
    expect(normalizePageSize(undefined)).toBe(20);
    expect(normalizePageSize("abc")).toBe(20);
    expect(normalizePageSize(500)).toBe(100);
    expect(normalizePageSize(0)).toBe(1);
    expect(normalizePageSize("50")).toBe(50);
  });
});

describe("pageCount", () => {
  it("一条都没有也算一页", () => {
    expect(pageCount(0, 20)).toBe(1);
  });

  it("整除和不整除都对", () => {
    expect(pageCount(40, 20)).toBe(2);
    expect(pageCount(41, 20)).toBe(3);
  });
});

describe("pageLabel", () => {
  it("和代理端分页条一字不差", () => {
    expect(pageLabel(45, 2, 20)).toBe("共 45 条，第 2 / 3 页");
    expect(pageLabel(0, 1, 20)).toBe("共 0 条，第 1 / 1 页");
  });
});

describe("hasNextPage", () => {
  it("最后一页没有下一页", () => {
    expect(hasNextPage(45, 2, 20)).toBe(true);
    expect(hasNextPage(45, 3, 20)).toBe(false);
    expect(hasNextPage(40, 2, 20)).toBe(false);
  });
});
