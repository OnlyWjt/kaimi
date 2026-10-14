import { ZodError } from "zod";
import { sanitizeLog } from "./log";

const BUSY_MESSAGE = "系统繁忙，请稍后再试";

/**
 * drizzle 的数据库错误是「Failed query: <SQL> params: <参数>」，参数里有买家邮箱、IP、卡密前缀，
 * 不能原样回给买家或代理；真正的原因（SQLITE_BUSY、SQLITE_FULL…）在 cause 里，页面上反而看不到。
 */
export function isDatabaseError(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith("Failed query")) return true;
  const cause = (error as { cause?: unknown }).cause;
  const code = (error as { code?: unknown }).code ?? (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_");
}

/** 数据库错误的真实原因，只给日志用：错误码和 SQLite 的说明，再加 SQL 开头，不带参数。 */
export function databaseErrorSummary(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const source = cause instanceof Error ? cause : error;
  const code = (source as { code?: unknown }).code;
  const sql = error.message.startsWith("Failed query:")
    ? error.message.slice("Failed query:".length).split(/\s+params:/)[0].trim().slice(0, 120)
    : "";
  return [typeof code === "string" ? code : "", cause instanceof Error ? cause.message : "", sql ? `SQL: ${sql}` : ""]
    .filter(Boolean)
    .join(" | ");
}

/**
 * 给买家、代理、开放 API 调用方看的错误文案。业务错误（库存不足、券不能用…）原样返回；
 * 数据库错误换成「系统繁忙」，真实原因写日志。
 */
export function publicErrorMessage(error: unknown, fallback: string, where = "api") {
  if (isDatabaseError(error)) {
    console.error(`[${where}] 数据库操作失败：${sanitizeLog(databaseErrorSummary(error))}`);
    return BUSY_MESSAGE;
  }
  // zod 的 message 是整段英文 JSON，req.json() 解析失败是 "Unexpected token…"，都不该原样给买家看。
  if (error instanceof ZodError) return `${fallback}：提交的内容不完整或格式不对`;
  if (error instanceof SyntaxError) return `${fallback}：请求格式不对，请刷新页面后重试`;
  return error instanceof Error && error.message ? error.message : fallback;
}
