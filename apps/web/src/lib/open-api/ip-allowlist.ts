import { BlockList, isIP } from "node:net";
import { ALLOWLIST_ENFORCED_FROM, MAX_ALLOWLIST_ENTRIES } from "./key-policy";
import { isBlockedIp } from "./webhook-url";

export { ALLOWLIST_ENFORCED_FROM, MAX_ALLOWLIST_ENTRIES };

/** 网段最宽能放到多少：IPv4 一个 /24，IPv6 一个 /64。再宽白名单就形同虚设。 */
const MIN_PREFIX = { 4: 24, 6: 64 } as const;

export type KeyMode = "live" | "test";

/** 去掉方括号、IPv4 映射地址还原成 IPv4，统一小写。不是 IP 返回 null。 */
export function normalizeIp(raw: string) {
  const ip = raw.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
    if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
    return ip;
  }
  return null;
}

/** 解析一条白名单：单个 IP 或 CIDR 网段。返回规范写法，或者给人看的错误。 */
function parseEntry(raw: string): { entry: string } | { error: string } {
  const [addressPart, prefixPart, extra] = raw.split("/");
  const address = normalizeIp(addressPart ?? "");
  if (!address || extra !== undefined) return { error: `「${raw}」不是有效的 IP 或网段` };
  const family = isIP(address) as 4 | 6;
  if (isBlockedIp(address)) return { error: `「${raw}」是内网或保留地址，请填服务器的公网出口 IP` };
  if (prefixPart === undefined) return { entry: address };
  if (!/^\d{1,3}$/.test(prefixPart)) return { error: `「${raw}」的网段位数不对` };
  const prefix = Number(prefixPart);
  const max = family === 4 ? 32 : 128;
  if (prefix > max) return { error: `「${raw}」的网段位数不对` };
  if (prefix < MIN_PREFIX[family]) {
    return { error: `「${raw}」范围太大，IPv${family} 网段最宽 /${MIN_PREFIX[family]}` };
  }
  return { entry: prefix === max ? address : `${address}/${prefix}` };
}

/** 后台提交上来的白名单：逐条校验、去重。空列表算合法，要不要必填由调用方判断。 */
export function parseAllowlist(input: readonly string[]): { ok: true; entries: string[] } | { ok: false; error: string } {
  const entries: string[] = [];
  for (const raw of input.map((item) => item.trim()).filter(Boolean)) {
    const parsed = parseEntry(raw);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    if (!entries.includes(parsed.entry)) entries.push(parsed.entry);
  }
  if (entries.length > MAX_ALLOWLIST_ENTRIES) {
    return { ok: false, error: `IP 白名单最多 ${MAX_ALLOWLIST_ENTRIES} 条` };
  }
  return { ok: true, entries };
}

/** 正式 Key 必须有白名单；测试 Key 只能动沙箱，选填。 */
export function allowlistRequired(mode: KeyMode) {
  return mode === "live";
}

export function ipInAllowlist(ip: string, entries: readonly string[]) {
  const address = normalizeIp(ip);
  if (!address) return false;
  const list = new BlockList();
  for (const entry of entries) {
    const [base, prefix] = entry.split("/");
    const family = isIP(base ?? "");
    if (!family) continue;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(base!, type);
    else list.addSubnet(base!, Number(prefix), type);
  }
  return list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
}

/**
 * 这次请求的来源 IP 能不能用这把 Key。放行返回 null，否则返回给调用方看的原因，
 * 原因里带上我们看到的来源 IP，对方照着填进白名单就行。
 */
export function checkKeySource(input: {
  mode: KeyMode;
  allowlist: readonly string[];
  ip: string;
  now?: Date;
}) {
  if (input.allowlist.length) {
    if (ipInAllowlist(input.ip, input.allowlist)) return null;
    return `来源 IP ${input.ip} 不在这把 Key 的白名单里`;
  }
  if (!allowlistRequired(input.mode)) return null;
  const now = input.now ?? new Date();
  if (now.toISOString() < ALLOWLIST_ENFORCED_FROM) return null;
  return `这把 Key 还没设置 IP 白名单，请到后台「开放 API」里填上调用方服务器的 IP（这次请求的来源 IP 是 ${input.ip}）`;
}
