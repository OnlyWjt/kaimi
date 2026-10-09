import { beforeEach, describe, expect, it } from "vitest";
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  clearLoginFailures,
  loginLockedFor,
  recordLoginFailure,
  resetLoginLockouts,
} from "./login-lockout";

describe("login lockout", () => {
  beforeEach(() => resetLoginLockouts());

  it("locks after max failures within the window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) recordLoginFailure("alice", t0 + i);
    expect(loginLockedFor("alice", t0 + 100)).toBe(0);
    recordLoginFailure("alice", t0 + 200);
    expect(loginLockedFor("alice", t0 + 300)).toBeGreaterThan(0);
  });

  it("normalizes username case and whitespace", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(i % 2 ? " Bob " : "bob", t0);
    expect(loginLockedFor("BOB", t0 + 1)).toBeGreaterThan(0);
  });

  it("unlocks after the window expires", () => {
    const t0 = 3_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure("carol", t0);
    expect(loginLockedFor("carol", t0 + LOGIN_WINDOW_MS + 1)).toBe(0);
    recordLoginFailure("carol", t0 + LOGIN_WINDOW_MS + 2);
    expect(loginLockedFor("carol", t0 + LOGIN_WINDOW_MS + 3)).toBe(0);
  });

  it("clears on success and isolates usernames", () => {
    const t0 = 4_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure("dave", t0);
    expect(loginLockedFor("erin", t0)).toBe(0);
    clearLoginFailures("dave");
    expect(loginLockedFor("dave", t0)).toBe(0);
  });
});
