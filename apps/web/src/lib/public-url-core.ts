export function normalizePublicBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function isLoopbackHttpUrl(value: string) {
  try {
    const url = new URL(normalizePublicBaseUrl(value));
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(normalizePublicBaseUrl(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!url.hostname) return false;
    return !isLoopbackHttpUrl(value);
  } catch {
    return false;
  }
}

export function isEphemeralPublicHost(value: string) {
  try {
    const host = new URL(normalizePublicBaseUrl(value)).hostname.toLowerCase();
    return (
      host.endsWith(".loca.lt") ||
      host.endsWith(".trycloudflare.com") ||
      host.endsWith(".localtunnel.me") ||
      host.endsWith(".ngrok.io") ||
      host.endsWith(".ngrok-free.app") ||
      host.endsWith(".ngrok.app")
    );
  } catch {
    return false;
  }
}
