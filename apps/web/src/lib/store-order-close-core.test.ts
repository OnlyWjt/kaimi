import { describe, expect, it } from "vitest";
import { gatewayPaidCheckOutcome, shouldCloseUnpaidOrder } from "./store-order-close-core";

const now = new Date("2026-10-13T12:00:00.000Z");

describe("gatewayPaidCheckOutcome", () => {
  it("maps confirm results", () => {
    expect(gatewayPaidCheckOutcome({ kind: "ok" })).toBe("paid");
    expect(gatewayPaidCheckOutcome({ kind: "unpaid" })).toBe("unpaid");
    expect(gatewayPaidCheckOutcome({ kind: "missing" })).toBe("unpaid");
    expect(gatewayPaidCheckOutcome({ kind: "rejected" })).toBe("error");
  });
});

describe("shouldCloseUnpaidOrder", () => {
  it("never closes an order the gateway says is paid", () => {
    expect(shouldCloseUnpaidOrder({ check: "paid", createdAt: "2026-01-01T00:00:00.000Z", now })).toBe(false);
  });

  it("closes confirmed-unpaid orders and orders without a gateway check", () => {
    expect(shouldCloseUnpaidOrder({ check: "unpaid", createdAt: "2026-10-13T11:00:00.000Z", now })).toBe(true);
    expect(shouldCloseUnpaidOrder({ check: null, createdAt: "2026-10-13T11:00:00.000Z", now })).toBe(true);
  });

  it("keeps unclear orders until the give-up window passes", () => {
    expect(shouldCloseUnpaidOrder({ check: "error", createdAt: "2026-10-13T11:00:00.000Z", now })).toBe(false);
    expect(shouldCloseUnpaidOrder({ check: "error", createdAt: "2026-10-12T11:00:00.000Z", now })).toBe(true);
  });
});
