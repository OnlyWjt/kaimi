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
    "易支付回调不能使用 localhost。请到后台「系统 › 接入卡台」填写可被外网访问的本站地址，例如 https://你的域名",
  );
}

export const CALLBACK_BASE_URL_SETTING = "payment_callback_base_url";

/**
 * 给支付网关、卡台这类服务器回调本站用的地址。
 *
 * 和买家看到的公网地址分开：回调常要绕开 Cloudflare 之类的代理（另配一个不走代理的域名），
 * 买家链接则要用代理的正式域名。没单独配时沿用公网地址。
 */
export async function getCallbackBaseUrl(req?: Request) {
  const candidates = [
    await getSetting(CALLBACK_BASE_URL_SETTING),
    process.env.KAIMI_CALLBACK_BASE_URL || "",
  ];
  for (const raw of candidates) {
    const value = normalizePublicBaseUrl(raw);
    if (isPublicHttpUrl(value)) return value;
  }
  return getPublicBaseUrl(req);
}

export async function requireCallbackBaseUrl(req?: Request) {
  const base = await getCallbackBaseUrl(req);
  if (base) return base;
  throw new Error(
    "易支付回调不能使用 localhost。请到后台「系统 › 接入卡台」填写可被外网访问的本站地址，例如 https://你的域名",
  );
}
