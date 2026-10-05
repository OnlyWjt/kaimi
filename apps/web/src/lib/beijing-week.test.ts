import { describe, expect, it } from "vitest";
import {
  addDaysYmd,
  beijingMondayYmd,
  beijingWeekBounds,
  previousCompletedWeekYmd,
} from "./beijing-week";

describe("beijing week", () => {
  it("treats Monday 00:00 Beijing as the week start", () => {
    const mondayMorning = new Date("2026-10-04T16:30:00.000Z");
    expect(beijingMondayYmd(mondayMorning)).toBe("2026-10-05");
    expect(previousCompletedWeekYmd(mondayMorning)).toBe("2026-09-28");
  });

  it("keeps Sunday evening Beijing in the same week", () => {
    const sundayNight = new Date("2026-10-04T15:30:00.000Z");
    expect(beijingMondayYmd(sundayNight)).toBe("2026-09-28");
    expect(previousCompletedWeekYmd(sundayNight)).toBe("2026-09-21");
  });

  it("bounds a week from Monday 00:00 to Sunday 24:00 Beijing", () => {
    const bounds = beijingWeekBounds("2026-09-28");
    expect(bounds.start).toBe("2026-09-27T16:00:00.000Z");
    expect(bounds.end).toBe("2026-10-04T15:59:59.999Z");
    expect(addDaysYmd(bounds.mondayYmd, 6)).toBe("2026-10-04");
  });
});
