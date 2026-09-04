import { describe, expect, it } from "vitest";
import {
  canApplyUpstreamCdkStatus,
  mapUpstreamCdkStatus,
} from "./issued-status-core";

describe("mapUpstreamCdkStatus", () => {
  it("consumed 和 used 都是已使用", () => {
    expect(mapUpstreamCdkStatus("consumed")).toBe("used");
    expect(mapUpstreamCdkStatus(" USED ")).toBe("used");
  });

  it("认不出来的状态返回空串，表示不动这一行", () => {
    expect(mapUpstreamCdkStatus("pending_review")).toBe("");
    expect(mapUpstreamCdkStatus("")).toBe("");
  });
});

describe("canApplyUpstreamCdkStatus", () => {
  it("本地正在兑换时，上游的 unused 一律不许落地", () => {
    expect(canApplyUpstreamCdkStatus("locked", "unused")).toBe(false);
    expect(canApplyUpstreamCdkStatus("redeeming", "unused")).toBe(false);
  });

  it("已核销或已禁用的卡也不许退回可售", () => {
    expect(canApplyUpstreamCdkStatus("used", "unused")).toBe(false);
    expect(canApplyUpstreamCdkStatus("disabled", "unused")).toBe(false);
  });

  it("上游说这张已经花掉或被封了，任何本地状态都得跟上", () => {
    expect(canApplyUpstreamCdkStatus("locked", "used")).toBe(true);
    expect(canApplyUpstreamCdkStatus("redeeming", "used")).toBe(true);
    expect(canApplyUpstreamCdkStatus("unused", "disabled")).toBe(true);
  });

  it("状态没变或映射不出来就什么都不做", () => {
    expect(canApplyUpstreamCdkStatus("used", "used")).toBe(false);
    expect(canApplyUpstreamCdkStatus("unused", "")).toBe(false);
  });
});
