import { describe, expect, it } from "vitest";
import {
  formatGrantPlansToast,
  grantPlansLabel,
  nextGrantAction,
} from "./plan-grant-core";

describe("nextGrantAction", () => {
  it("没有行就插入", () => {
    expect(nextGrantAction(null)).toBe("insert");
    expect(nextGrantAction(undefined)).toBe("insert");
  });

  it("关掉的行只重新打开，不改零售/成本", () => {
    expect(nextGrantAction({ enabled: false })).toBe("enable");
  });

  it("已经在卖就跳过", () => {
    expect(nextGrantAction({ enabled: true })).toBe("skip");
  });
});

describe("grant toast", () => {
  it("拼出已开放和本来就能卖的家数", () => {
    expect(
      formatGrantPlansToast({
        planLabel: "月卡",
        grantedAgentCount: 3,
        alreadyAgentCount: 2,
      }),
    ).toBe("已给 3 家店加上 月卡。2 家本来就能卖。");
    expect(grantPlansLabel(["月卡"])).toBe("月卡");
    expect(grantPlansLabel(["月卡", "季卡", "年卡", "周卡"])).toBe("4 个套餐");
  });
});
