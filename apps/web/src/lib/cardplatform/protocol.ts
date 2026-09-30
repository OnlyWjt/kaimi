export const CARDPLATFORM_PROTOCOLS = [
  "spacexcard-legacy",
  "avanfinity-2026-08",
] as const;

export type CardplatformProtocol = (typeof CARDPLATFORM_PROTOCOLS)[number];

export function normalizeCardplatformProtocol(value: string): CardplatformProtocol {
  const raw = value.trim().toLowerCase();
  if (
    raw === "avanfinity" ||
    raw === "avanfinity-2026-08" ||
    raw === "avanfinity-2026"
  ) {
    return "avanfinity-2026-08";
  }
  return "spacexcard-legacy";
}

/** 付款地区只存在于旧台协议。Avanfinity 带上会被拒或被忽略后按菲律宾扣款。 */
export function supportsPaymentCountry(protocol: string) {
  return normalizeCardplatformProtocol(protocol) === "spacexcard-legacy";
}

export function cardplatformProtocolLabel(value: string) {
  return normalizeCardplatformProtocol(value) === "avanfinity-2026-08"
    ? "Avanfinity"
    : "SpaceX Legacy";
}
