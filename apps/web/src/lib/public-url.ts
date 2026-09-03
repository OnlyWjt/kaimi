import { getSetting } from "@/lib/config";
import {
  isPublicHttpUrl,
  normalizePublicBaseUrl,
} from "@/lib/public-url-core";

export {
  isEphemeralPublicHost,
  isLoopbackHttpUrl,
  isPublicHttpUrl,
  normalizePublicBaseUrl,
} from "@/lib/public-url-core";

function originFromRequest(req: Request) {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "";
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

export async function getPublicBaseUrl(req?: Request) {
  const candidates = [
    await getSetting("public_base_url"),
    process.env.KAIMI_PUBLIC_BASE_URL || "",
    req ? originFromRequest(req) : "",
  ];
  for (const raw of candidates) {
    const value = normalizePublicBaseUrl(raw);
    if (isPublicHttpUrl(value)) return value;
  }
  return "";
}

export async function requirePublicBaseUrl(req?: Request) {
  const base = await getPublicBaseUrl(req);
  if (base) return base;
  throw new Error(
    "易支付回调不能使用 localhost。请到「即时发卡」填写可被外网访问的本站地址，例如 https://你的域名",
  );
}
