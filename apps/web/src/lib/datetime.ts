const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NO_TIMEZONE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

type Shape = "local" | "localSeconds" | "beijing" | "utcDate";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * 解析本站库里的时间戳，认不出来给 null。
 *
 * 库里存的都是 UTC，但两种写法混着：`new Date().toISOString()` 带 Z，SQLite 的
 * `datetime('now')` 是 "2026-09-07 11:40:37" 这种没有时区后缀的。没后缀那种交给 Date
 * 各引擎会按本地时间解析，所以这里手动补一个 Z。
 *
 * 只能喂本站自己写的值。上游报文里的时间戳按它自己的时区来，补 Z 会把它算错。
 */
export function parseDbDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(NO_TIMEZONE.test(raw) ? `${raw.replace(" ", "T")}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function render(date: Date, shape: Shape) {
  const utc = shape === "beijing" || shape === "utcDate";
  const at = shape === "beijing" ? new Date(date.getTime() + BEIJING_OFFSET_MS) : date;
  const year = utc ? at.getUTCFullYear() : at.getFullYear();
  const month = pad((utc ? at.getUTCMonth() : at.getMonth()) + 1);
  const day = pad(utc ? at.getUTCDate() : at.getDate());
  if (shape === "utcDate") return `${year}-${month}-${day}`;
  const hour = pad(utc ? at.getUTCHours() : at.getHours());
  const minute = pad(utc ? at.getUTCMinutes() : at.getMinutes());
  const head = `${year}-${month}-${day} ${hour}:${minute}`;
  if (shape === "local") return head;
  return `${head}:${pad(utc ? at.getUTCSeconds() : at.getSeconds())}`;
}

/** 认不出来的值原样吐回去，宁可难看也不要显示成错的时间。 */
function formatStamp(value: unknown, shape: Shape, empty: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return empty;
  if (DATE_ONLY.test(raw)) return raw;
  const date = parseDbDate(raw);
  return date ? render(date, shape) : raw;
}

/**
 * 列表里的时间戳，按浏览者本地时区显示。自己拼字符串而不用 toLocaleString：输出跟库里
 * 的 ISO 写法对得上，也不受浏览器语言影响。
 */
export function formatDateTime(value: unknown, empty = "—") {
  return formatStamp(value, "local", empty);
}

/**
 * 公告这类短时间：本地时区的「9月12日 22:07」。不用 toLocaleString，避免 Windows 中文
 * 环境变成 `09/12 22:07:07`。不带秒。
 */
export function formatLocalMonthDayTime(value: unknown, empty = "—") {
  const raw = String(value ?? "").trim();
  if (!raw) return empty;
  if (DATE_ONLY.test(raw)) return raw;
  const date = parseDbDate(raw);
  if (!date) return raw;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}月${day}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 排障用的流水要看到秒。 */
export function formatDateTimeSeconds(value: unknown, empty = "—") {
  return formatStamp(value, "localSeconds", empty);
}

/** 服务端导出拿不到查看者时区，统一按北京时间落格，列名里也标了「北京时间」。 */
export function formatBeijingDateTime(value: unknown) {
  return formatStamp(value, "beijing", "");
}

/** 结算周期的边界是按 UTC 日切出来的，只落日期，避免换算后跨到别的一天。 */
export function formatUtcDate(value: unknown) {
  return formatStamp(value, "utcDate", "");
}
