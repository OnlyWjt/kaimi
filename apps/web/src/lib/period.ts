export function periodBoundary(value: string, end: boolean) {
  const trimmed = value.trim();
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${end ? "23:59:59.999" : "00:00:00.000"}Z`
    : trimmed;
  const date = new Date(expanded);
  if (Number.isNaN(date.getTime())) throw new Error("时间范围格式无效");
  return date.toISOString();
}
