import { describe, expect, it } from "vitest";
import {
  finishedAccountIdFromRef,
  formatFinishedAccountLine,
  isFinishedRef,
  isLocalAccountPlan,
  maskFinishedEmail,
  parseFinishedAccountLine,
  parseFinishedAccountLines,
  splitFinishedAccountLine,
} from "./finished-account-core";

const session = "s".repeat(24);

describe("parseFinishedAccountLine", () => {
  it("按四段拆开", () => {
    expect(
      parseFinishedAccountLine(`A@Gmail.com----gptPass----mailPass----${session}`),
    ).toEqual({
      email: "a@gmail.com",
      gptPassword: "gptPass",
      mailboxPassword: "mailPass",
      session,
    });
  });

  it("段数不对或 Session 太短就拒绝", () => {
    expect(() => parseFinishedAccountLine("a@b.com----x----y")).toThrow("格式应为");
    expect(() =>
      parseFinishedAccountLine("a@b.com----x----y----short"),
    ).toThrow("Session 太短");
  });
});

describe("parseFinishedAccountLines", () => {
  it("跳过空行，重复邮箱记失败", () => {
    const result = parseFinishedAccountLines(
      [
        `a@b.com----x----y----${session}`,
        "",
        `a@b.com----z----w----${session}`,
        `c@b.com----x----y----${session}`,
      ].join("\n"),
    );
    expect(result.accepted.map((row) => row.email)).toEqual(["a@b.com", "c@b.com"]);
    expect(result.rejected).toEqual([{ line: 3, reason: "这份里邮箱重复" }]);
  });
});

describe("formatFinishedAccountLine", () => {
  it("拼回入库格式", () => {
    expect(
      formatFinishedAccountLine({
        email: "a@b.com",
        gptPassword: "x",
        mailboxPassword: "y",
        session,
      }),
    ).toBe(`a@b.com----x----y----${session}`);
  });
});

describe("提卡交付行", () => {
  it("拆四段，不做导入校验；段数不对返回 null", () => {
    expect(splitFinishedAccountLine("x@y.com----=pw----mb----short")).toEqual({
      email: "x@y.com",
      gptPassword: "=pw",
      mailboxPassword: "mb",
      session: "short",
    });
    expect(splitFinishedAccountLine("CDK-ABCD-1234")).toBeNull();
  });

  it("邮箱只打 @ 前面", () => {
    expect(maskFinishedEmail("abcdef@outlook.com")).toBe("ab****@outlook.com");
    expect(maskFinishedEmail("ab@outlook.com")).toBe("a****@outlook.com");
    expect(maskFinishedEmail("a@outlook.com")).toBe("a****@outlook.com");
  });

  it("从 upstream_ref 认成品号", () => {
    expect(isFinishedRef("finished:12")).toBe(true);
    expect(isFinishedRef("98231")).toBe(false);
    expect(finishedAccountIdFromRef("finished:12")).toBe(12);
    expect(finishedAccountIdFromRef("finished:x")).toBeNull();
    expect(finishedAccountIdFromRef("12")).toBeNull();
  });
});

describe("isLocalAccountPlan", () => {
  it("认履约类型和成品号套餐键", () => {
    expect(isLocalAccountPlan({ fulfillmentKind: "local_account" })).toBe(true);
    expect(isLocalAccountPlan({ planKey: "finished_gpt" })).toBe(true);
    expect(isLocalAccountPlan({ planKey: "plus" })).toBe(false);
  });
});
