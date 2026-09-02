const IPV4_PROBES = [
  { url: "https://api.ipify.org?format=text", source: "ipify" },
  { url: "https://ipv4.icanhazip.com", source: "icanhazip-v4" },
  { url: "https://v4.ident.me", source: "ident.me" },
];

const ANY_PROBES = [
  { url: "https://api64.ipify.org?format=text", source: "ipify64" },
  { url: "https://ifconfig.me/ip", source: "ifconfig.me" },
  { url: "https://icanhazip.com", source: "icanhazip" },
];

function looksLikeIp(value: string) {
  const text = value.trim();
  if (!text || /[\s<>]/.test(text)) return false;
  return /^[0-9a-fA-F:.]+$/.test(text);
}

export function isIpv4(value: string) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim());
}

export function isIpv6(value: string) {
  return value.includes(":") && looksLikeIp(value);
}

async function probe(
  probes: { url: string; source: string }[],
  accept: (value: string) => boolean,
) {
  let lastError = "出口 IP 探测失败";
  for (const item of probes) {
    try {
      const response = await fetch(item.url, {
        headers: { "User-Agent": "kaimi/egress-check" },
        signal: AbortSignal.timeout(6_000),
        cache: "no-store",
      });
      const text = (await response.text()).trim();
      if (!response.ok || !looksLikeIp(text) || !accept(text)) {
        lastError = `探测失败（${item.source} HTTP ${response.status}）`;
        continue;
      }
      return { ip: text, source: item.source, error: "" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ip: "", source: "", error: lastError };
}

export async function detectEgressIp() {
  const v4 = await probe(IPV4_PROBES, isIpv4);
  if (v4.ip) {
    return {
      ip: v4.ip,
      ipv4: v4.ip,
      ipv6: "",
      source: v4.source,
      error: "",
    };
  }
  const any = await probe(ANY_PROBES, looksLikeIp);
  return {
    ip: any.ip,
    ipv4: isIpv4(any.ip) ? any.ip : "",
    ipv6: isIpv6(any.ip) ? any.ip : "",
    source: any.source,
    error: any.ip ? "" : any.error,
  };
}
