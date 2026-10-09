import { isIP } from "node:net";

/**
 * Webhook 回调地址的 SSRF 防护。登记和每次投递都要过一遍：
 * - 只允许 https，不允许带账号密码；
 * - 拒绝 localhost 和内网 IP 字面量；
 * - 解析 DNS 后，任何一条记录落在回环/私有/链路本地/CGNAT/多播等网段都拒绝。
 *
 * 解析函数可注入，方便单测；默认用 node:dns/promises 的 lookup(all)。
 */

export type LookupAddress = { address: string; family: number };
export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

export type WebhookUrlCheck = { ok: true; url: URL } | { ok: false; error: string };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4(n: number, base: string, bits: number) {
  const b = ipv4ToInt(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(b / size);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // 本网络
  ["10.0.0.0", 8], // 私有
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // 回环
  ["169.254.0.0", 16], // 链路本地（含云元数据 169.254.169.254）
  ["172.16.0.0", 12], // 私有
  ["192.0.0.0", 24], // IETF 协议分配
  ["192.168.0.0", 16], // 私有
  ["198.18.0.0", 15], // 基准测试
  ["224.0.0.0", 4], // 多播
  ["240.0.0.0", 4], // 保留 + 广播
];

export function isBlockedIpv4(ip: string) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // 解析不了就当不安全
  return BLOCKED_V4.some(([base, bits]) => inV4(n, base, bits));
}

/** 把 IPv6 展开成 8 个 16 位整数；末尾内嵌 IPv4 也处理。失败返回 null。 */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // 末尾内嵌 IPv4（如 ::ffff:127.0.0.1）先换成两个十六进制分组
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parse(halves[0]!);
  let groups = head;
  if (halves.length === 2) {
    const rest = parse(halves[1]!);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

export function isBlockedIpv6(ip: string) {
  const g = expandIpv6(ip);
  if (!g) return true;
  const first = g[0]!;
  // ::/96：含 :: 未指定、::1 回环、已废弃的 IPv4 兼容地址
  if (g.slice(0, 6).every((x) => x === 0)) return true;
  // ::ffff:0:0/96 IPv4 映射地址：按内嵌的 IPv4 判断，一律不放行公网以外的
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    return isBlockedIpv4(v4);
  }
  // 64:ff9b::/96 NAT64：同样按内嵌 IPv4 判断
  if (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    return isBlockedIpv4(v4);
  }
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 已废弃站点本地
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 多播
  return false;
}

/** 任意 IP 字面量是否落在禁止网段。不是 IP 返回 true（保守）。 */
export function isBlockedIp(ip: string) {
  const family = isIP(ip.replace(/^\[|\]$/g, ""));
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip.replace(/^\[|\]$/g, ""));
  return true;
}

/** 不做网络请求的那部分校验：协议、凭据、localhost、IP 字面量。 */
export function checkWebhookUrlSyntax(raw: string): WebhookUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "回调地址格式不正确" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "回调地址必须是 https" };
  if (url.username || url.password) return { ok: false, error: "回调地址不能包含账号密码" };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return { ok: false, error: "回调地址缺少主机名" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, error: "回调地址不能指向本机或内网" };
  }
  if (isIP(host) && isBlockedIp(host)) {
    return { ok: false, error: "回调地址不能指向本机或内网" };
  }
  return { ok: true, url };
}

const defaultLookup: LookupAll = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  return lookup(hostname, { all: true, verbatim: true });
};

/** 完整校验：语法 + DNS 解析结果。登记和投递前都调用。 */
export async function checkWebhookUrl(
  raw: string,
  lookupAll: LookupAll = defaultLookup,
): Promise<WebhookUrlCheck> {
  const syntax = checkWebhookUrlSyntax(raw);
  if (!syntax.ok) return syntax;
  const host = syntax.url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return syntax; // 字面量已在语法阶段判过
  let addresses: LookupAddress[];
  try {
    addresses = await lookupAll(host);
  } catch {
    return { ok: false, error: "回调地址域名无法解析" };
  }
  if (!addresses.length) return { ok: false, error: "回调地址域名无法解析" };
  if (addresses.some((item) => isBlockedIp(item.address))) {
    return { ok: false, error: "回调地址不能指向本机或内网" };
  }
  return syntax;
}
