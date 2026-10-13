import { describe, expect, it } from "vitest";
import { agentOrderStatus, parseAgentOrderKeyword, parseAgentOrderView } from "./agent-orders-core";

describe("parseAgentOrderView", () => {
  it("falls back to all for unknown values", () => {
    expect(parseAgentOrderView("attention")).toBe("attention");
    expect(parseAgentOrderView("drop table")).toBe("all");
    expect(parseAgentOrderView(null)).toBe("all");
  });
});

describe("agentOrderStatus", () => {
  it("labels unpaid and closed orders", () => {
    expect(agentOrderStatus("unpaid", "pending").label).toBe("待付款");
    expect(agentOrderStatus("closed", "cancelled").label).toBe("已关闭");
  });

  it("flags paid orders that need attention", () => {
    expect(agentOrderStatus("paid", "delivered").tone).toBe("ok");
    expect(agentOrderStatus("paid", "unknown")).toMatchObject({ label: "发货待核实", tone: "bad" });
    expect(agentOrderStatus("paid", "paid_undelivered").tone).toBe("bad");
    expect(agentOrderStatus("paid", "partially_delivered").tone).toBe("wait");
  });
});

describe("parseAgentOrderKeyword", () => {
  it("treats @ as email and lowercases it", () => {
    expect(parseAgentOrderKeyword(" Buyer@Example.com ")).toEqual({ kind: "email", value: "buyer@example.com" });
  });

  it("treats the rest as order number and strips wildcards", () => {
    expect(parseAgentOrderKeyword("ks2026%_ab")).toEqual({ kind: "orderNo", value: "KS2026AB" });
    expect(parseAgentOrderKeyword("  ")).toBeNull();
  });
});
