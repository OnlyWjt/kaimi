import { getSetting } from "@/lib/config";

export async function getPublicBaseUrl(req?: Request) {
  const fromSetting = (await getSetting("public_base_url")).trim().replace(/\/+$/, "");
  if (fromSetting) return fromSetting;
  const fromEnv = process.env.KAIMI_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (!req) return "";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "localhost:3100";
  return `${proto}://${host}`.replace(/\/+$/, "");
}
