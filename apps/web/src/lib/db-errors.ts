/**
 * 违反唯一约束（重复的单号、券码、用户名、幂等键……）。
 *
 * drizzle 0.44 起会把数据库错误包一层 `Failed query: insert …`，真正的
 * `UNIQUE constraint failed` 在 cause 里。只看 error.message 会认不出来：
 * 幂等重试变 500、重复券码把整条 SQL 甩给代理。这里顺着 cause 往下找。
 */
export function isUniqueViolation(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const text =
      current instanceof Error
        ? `${current.message} ${(current as { code?: unknown }).code ?? ""}`
        : String(current);
    if (/UNIQUE|SQLITE_CONSTRAINT_UNIQUE/i.test(text)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
