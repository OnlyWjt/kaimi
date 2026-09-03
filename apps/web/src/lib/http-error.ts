export function messageFromApiBody(
  data: unknown,
  fallback = "请求失败",
): string {
  if (!data || typeof data !== "object") return fallback;
  const body = data as Record<string, unknown>;
  const fromError = stringifyErrorField(body.error);
  if (fromError) return fromError;
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message.trim();
  }
  const connect = body.connect;
  if (connect && typeof connect === "object") {
    const nested = connect as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim()) {
      return nested.message.trim();
    }
    if (typeof nested.error === "string" && nested.error.trim()) {
      return nested.error.trim();
    }
  }
  return fallback;
}

function stringifyErrorField(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!error || typeof error !== "object") return "";
  const obj = error as {
    formErrors?: unknown;
    fieldErrors?: Record<string, unknown>;
  };
  const form = Array.isArray(obj.formErrors)
    ? obj.formErrors.filter((item): item is string => typeof item === "string")
    : [];
  const fields =
    obj.fieldErrors && typeof obj.fieldErrors === "object"
      ? Object.entries(obj.fieldErrors).flatMap(([key, value]) =>
          Array.isArray(value)
            ? value
                .filter((item): item is string => typeof item === "string")
                .map((item) => `${key}: ${item}`)
            : [],
        )
      : [];
  return [...form, ...fields].join("；");
}

// 默认类型要允许调用方直接点属性，换成 unknown 会让每个调用点都得先断言。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readApiJson<T = Record<string, any>>(
  res: Response,
): Promise<T> {
  const raw = await res.text();
  let data: unknown = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (!res.ok) {
        throw new Error(
          raw.includes("<")
            ? `接口返回了网页而不是 JSON（HTTP ${res.status}）`
            : raw.slice(0, 180) || `请求失败（HTTP ${res.status}）`,
        );
      }
    }
  }
  if (!res.ok) {
    throw new Error(messageFromApiBody(data, `请求失败（HTTP ${res.status}）`));
  }
  return data as T;
}
