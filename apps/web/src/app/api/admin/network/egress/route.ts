import { NextResponse } from "next/server";
import { authorizeAdmin } from "@/lib/admin-guard";
import { detectEgressIp } from "@/lib/network/egress";

export async function GET() {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  const egress = await detectEgressIp();
  return NextResponse.json({
    egressIp: egress.ipv4 || egress.ip,
    egressIpv4: egress.ipv4,
    egressIpv6: egress.ipv6,
    egressSource: egress.source,
    egressError: egress.error,
    whitelistHint: egress.ipv4
      ? "请把这个 IPv4 加到卡台 API Key 白名单，否则连通会 403。"
      : "当前只探测到 IPv6。卡台白名单一般只认 IPv4，连通会报 IP 不在白名单。",
  });
}
