import { describe, expect, it } from "vitest";
import { formatAgentIssueAlertText } from "./agent-issue-alert-core";

describe("formatAgentIssueAlertText", () => {
  it("includes status, order and buyer", () => {
    const text = formatAgentIssueAlertText({
      orderNo: "KS1",
      productName: "Plus",
      quantity: 2,
      customerEmail: "buyer@example.com",
      payStatus: "paid",
      fulfillStatus: "unknown",
    });
    expect(text).toContain("发货待核实");
    expect(text).toContain("KS1");
    expect(text).toContain("Plus ×2");
    expect(text).toContain("buyer@example.com");
  });
});
