import { describe, expect, it } from "vitest";
import {
  AGENT_NOTIFY_ATTEMPTS,
  AGENT_NOTIFY_BACKOFF_MS,
  AGENT_NOTIFY_RETRY_MS,
  AGENT_NOTIFY_RETRYABLE,
  AGENT_NOTIFY_SENDING_STALE_MS,
  agentNotifyRetryWindow,
  canClaimAgentNotify,
} from "./notify-retry";

const NOW = Date.parse("2025-06-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("agentNotifyRetryWindow", () => {
  it("返回付款窗口与退避截止", () => {
    const w = agentNotifyRetryWindow(NOW);
    expect(w.paidSince).toBe(iso(NOW - AGENT_NOTIFY_RETRY_MS));
    expect(w.updatedBefore).toBe(iso(NOW - AGENT_NOTIFY_BACKOFF_MS));
  });
  it("调度器不重试 skipped/sent/sending", () => {
    expect(AGENT_NOTIFY_RETRYABLE).not.toContain("skipped");
    expect(AGENT_NOTIFY_RETRYABLE).not.toContain("sent");
    expect(AGENT_NOTIFY_RETRYABLE).not.toContain("sending");
  });
});

describe("canClaimAgentNotify", () => {
  const fresh = iso(NOW - 1000);
  const stale = iso(NOW - AGENT_NOTIFY_SENDING_STALE_MS - 1000);

  it("新订单/pending/failed 可占位", () => {
    for (const status of ["", "pending", "failed"]) {
      expect(canClaimAgentNotify({ status, attempts: 0, updatedAt: fresh }, NOW)).toBe(true);
    }
  });
  it("sent/skipped 不占位", () => {
    expect(canClaimAgentNotify({ status: "sent", attempts: 0, updatedAt: fresh }, NOW)).toBe(false);
    expect(canClaimAgentNotify({ status: "skipped", attempts: 0, updatedAt: fresh }, NOW)).toBe(false);
  });
  it("正在 sending 不重复占位，过期 sending 可接管", () => {
    expect(canClaimAgentNotify({ status: "sending", attempts: 0, updatedAt: fresh }, NOW)).toBe(false);
    expect(canClaimAgentNotify({ status: "sending", attempts: 0, updatedAt: stale }, NOW)).toBe(true);
  });
  it("达到上限不再占位，force 可绕过但仍不抢正在 sending 的行", () => {
    const row = { status: "failed", attempts: AGENT_NOTIFY_ATTEMPTS, updatedAt: fresh };
    expect(canClaimAgentNotify(row, NOW)).toBe(false);
    expect(canClaimAgentNotify(row, NOW, true)).toBe(true);
    expect(canClaimAgentNotify({ status: "sent", attempts: 0, updatedAt: fresh }, NOW, true)).toBe(true);
    expect(canClaimAgentNotify({ status: "sending", attempts: 0, updatedAt: fresh }, NOW, true)).toBe(false);
  });
});
