export function looksLikeStoreQueryToken(value: string) {
  return /^[A-Za-z0-9_-]{20,48}$/.test(value.trim());
}

export function pickStoreQueryToken(search: URLSearchParams) {
  const qt = search.get("qt")?.trim() || "";
  if (looksLikeStoreQueryToken(qt)) return qt;
  const token = search.get("token")?.trim() || "";
  if (looksLikeStoreQueryToken(token)) return token;
  return "";
}

export function epayParamsFromSearch(search: URLSearchParams) {
  const params: Record<string, string> = {};
  search.forEach((value, key) => {
    if (key === "qt" || key === "token") return;
    if (value) params[key] = value;
  });
  return params;
}
