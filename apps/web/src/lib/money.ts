export function yuanTextFromCents(cents: number) {
  return (Math.max(0, Math.trunc(cents)) / 100).toFixed(2);
}

export function centsFromYuanText(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return Number.NaN;
  return Math.round(Number(text) * 100);
}
