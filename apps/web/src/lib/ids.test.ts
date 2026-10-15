import { describe, expect, it } from "vitest";
import { newOrderNo } from "./ids";

describe("newOrderNo", () => {
  it("按北京时间写日期，UTC 前一天晚上 16 点后已是北京第二天", () => {
    const no = newOrderNo("KS", new Date("2026-10-14T17:05:00.000Z"));
    expect(no.slice(0, 14)).toBe("KS202610150105");
    expect(no).toMatch(/^KS\d{12}[2-9A-HJ-NP-Z]{10}$/);
  });
});
