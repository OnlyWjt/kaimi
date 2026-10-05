const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function ymdFromUtcDate(date: Date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 把绝对时间平移到北京时间后再取日历字段。 */
export function beijingParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

export function beijingMondayYmd(date = new Date()) {
  const parts = beijingParts(date);
  const weekday = parts.weekday === 0 ? 7 : parts.weekday;
  const monday = new Date(Date.UTC(parts.year, parts.month, parts.day) - (weekday - 1) * DAY_MS);
  return ymdFromUtcDate(monday);
}

export function addDaysYmd(ymd: string, days: number) {
  const [year, month, day] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return ymdFromUtcDate(next);
}

/** 上一周已经结束的周一（北京时间）。当前这一周不返回。 */
export function previousCompletedWeekYmd(date = new Date()) {
  return addDaysYmd(beijingMondayYmd(date), -7);
}

export function beijingWeekBounds(mondayYmd: string) {
  const sundayYmd = addDaysYmd(mondayYmd, 6);
  const start = new Date(`${mondayYmd}T00:00:00+08:00`);
  const end = new Date(`${sundayYmd}T23:59:59.999+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("周起始日期无效");
  }
  return {
    mondayYmd,
    sundayYmd,
    start: start.toISOString(),
    end: end.toISOString(),
    label: `${mondayYmd.slice(5)} ～ ${sundayYmd.slice(5)}`,
  };
}

export function recentWeekMondays(count = 8, date = new Date()) {
  const current = beijingMondayYmd(date);
  return Array.from({ length: count }, (_, index) => addDaysYmd(current, -7 * index));
}
