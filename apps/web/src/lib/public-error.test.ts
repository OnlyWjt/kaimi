import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseErrorSummary, isDatabaseError, publicErrorMessage } from "./public-error";

function drizzleError() {
  const cause = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
  return new Error(
    'Failed query: insert into "orders" ("email", "client_ip") values (?, ?) params: buyer@example.com,1.2.3.4',
    { cause },
  );
}

describe("publicErrorMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("数据库错误不把 SQL 和参数回给调用方，真实原因写日志", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = publicErrorMessage(drizzleError(), "下单失败", "test");
    expect(message).toBe("系统繁忙，请稍后再试");
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain("SQLITE_BUSY");
    expect(logged).toContain('insert into "orders"');
    expect(logged).not.toContain("buyer@example.com");
    expect(logged).not.toContain("1.2.3.4");
  });

  it("业务错误原样返回，非 Error 用兜底文案", () => {
    expect(publicErrorMessage(new Error("这张券已过期"), "下单失败")).toBe("这张券已过期");
    expect(publicErrorMessage("boom", "下单失败")).toBe("下单失败");
  });

  it("只有 SQLite 错误码、没有 Failed query 前缀也认得出", () => {
    const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    expect(isDatabaseError(error)).toBe(true);
    expect(databaseErrorSummary(error)).toContain("SQLITE_FULL");
    expect(isDatabaseError(new Error("库存不足"))).toBe(false);
  });
});
