import { describe, expect, it } from "vitest";
import {
  formatFinishedAccountLine,
  isLocalAccountPlan,
  parseFinishedAccountLine,
  parseFinishedAccountLines,
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

describe("isLocalAccountPlan", () => {
  it("认履约类型和成品号套餐键", () => {
    expect(isLocalAccountPlan({ fulfillmentKind: "local_account" })).toBe(true);
    expect(isLocalAccountPlan({ planKey: "finished_gpt" })).toBe(true);
    expect(isLocalAccountPlan({ planKey: "plus" })).toBe(false);
  });
});
