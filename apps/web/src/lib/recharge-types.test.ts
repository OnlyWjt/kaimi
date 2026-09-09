import { describe, expect, it } from "vitest";
import { shouldNotifyTerminalTransition } from "./recharge-types";

describe("shouldNotifyTerminalTransition", () => {
  it("处理中变成成功或失败才推", () => {
    expect(shouldNotifyTerminalTransition("processing", "success")).toBe(true);
    expect(shouldNotifyTerminalTransition("submitted", "failed")).toBe(true);
    expect(shouldNotifyTerminalTransition("pending", "unknown")).toBe(true);
  });

  it("已经成功的轮询不再推", () => {
    expect(shouldNotifyTerminalTransition("success", "success")).toBe(false);
    expect(shouldNotifyTerminalTransition("failed", "failed")).toBe(false);
  });

  it("结果未知后来确认成功也要推", () => {
    expect(shouldNotifyTerminalTransition("unknown", "success")).toBe(true);
  });
});
