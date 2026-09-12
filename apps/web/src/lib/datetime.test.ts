import { describe, expect, it } from "vitest";
import {
  formatBeijingDateTime,
  formatDateTime,
  formatDateTimeSeconds,
  formatLocalMonthDayTime,
  formatUtcDate,
  parseDbDate,
} from "./datetime";

describe("datetime formatting", () => {
  it("treats a zone-less SQLite datetime the same as the ISO one", () => {
    expect(formatDateTime("2026-09-07 11:40:37")).toBe(
      formatDateTime("2026-09-07T11:40:37.818Z"),
    );
    expect(formatDateTimeSeconds("2026-09-07 11:40:37")).toBe(
      formatDateTimeSeconds("2026-09-07T11:40:37.000Z"),
    );
  });

  it("renders export stamps in Beijing time", () => {
    expect(formatBeijingDateTime("2026-09-07T11:40:37.818Z")).toBe(
      "2026-09-07 19:40:37",
    );
    expect(formatBeijingDateTime("2026-09-07 16:40:37")).toBe(
      "2026-09-08 00:40:37",
    );
  });

  it("keeps a period bound on its UTC day", () => {
    expect(formatUtcDate("2026-09-01T00:00:00.000Z")).toBe("2026-09-01");
    expect(formatUtcDate("2026-09-30T23:59:59.999Z")).toBe("2026-09-30");
  });

  it("leaves empty, date-only and unparseable values alone", () => {
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("待确认")).toBe("待确认");
    expect(formatBeijingDateTime("2026-09-02")).toBe("2026-09-02");
    expect(formatBeijingDateTime("")).toBe("");
  });

  it("renders a local month-day clock without seconds or locale slashes", () => {
    const iso = "2026-09-12T14:07:09.000Z";
    const date = parseDbDate(iso);
    expect(date).not.toBeNull();
    const expected = `${date!.getMonth() + 1}月${date!.getDate()}日 ${String(date!.getHours()).padStart(2, "0")}:${String(date!.getMinutes()).padStart(2, "0")}`;
    expect(formatLocalMonthDayTime(iso)).toBe(expected);
    expect(formatLocalMonthDayTime(iso)).toMatch(/^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/);
    expect(formatLocalMonthDayTime("2026-09-07 11:40:37")).toBe(
      formatLocalMonthDayTime("2026-09-07T11:40:37.000Z"),
    );
    expect(formatLocalMonthDayTime("")).toBe("—");
    expect(formatLocalMonthDayTime("待确认")).toBe("待确认");
  });
});

describe("parseDbDate", () => {
  it("reads a zone-less SQLite datetime as UTC", () => {
    expect(parseDbDate("2026-09-07 11:40:37")?.toISOString()).toBe(
      "2026-09-07T11:40:37.000Z",
    );
    expect(parseDbDate("2026-09-07T11:40:37")?.toISOString()).toBe(
      "2026-09-07T11:40:37.000Z",
    );
    expect(parseDbDate("2026-09-07 11:40")?.toISOString()).toBe(
      "2026-09-07T11:40:00.000Z",
    );
  });

  it("keeps a timezone designator the value already carries", () => {
    expect(parseDbDate("2026-09-07T11:40:37.818Z")?.toISOString()).toBe(
      "2026-09-07T11:40:37.818Z",
    );
    expect(parseDbDate("2026-09-07T19:40:37+08:00")?.toISOString()).toBe(
      "2026-09-07T11:40:37.000Z",
    );
  });

  it("gives null for empty and unparseable values", () => {
    expect(parseDbDate("")).toBeNull();
    expect(parseDbDate(null)).toBeNull();
    expect(parseDbDate(undefined)).toBeNull();
    expect(parseDbDate("待确认")).toBeNull();
  });
});
