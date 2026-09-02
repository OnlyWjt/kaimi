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

export function cardplatformProtocolLabel(value: string) {
  return normalizeCardplatformProtocol(value) === "avanfinity-2026-08"
    ? "Avanfinity"
    : "SpaceX Legacy";
}
