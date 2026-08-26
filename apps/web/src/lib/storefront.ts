import { eq } from "drizzle-orm";
import { isThemeId, type ThemeId } from "@kaimi/themes";
import { db } from "@/db";
import { storefronts } from "@/db/schema";
import { bootDb, getSetting } from "@/lib/config";

export type SiteAppearance = {
  siteName: string;
  themeId: ThemeId;
  /** External storefront URL for 「购买卡密」. Empty = hide buy links. */
  buyCdkUrl: string;
  /** Internal /shop 发卡网开关，默认关闭。 */
  shopEnabled: boolean;
};

function normalizeExternalUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

/** Site-wide brand + theme from admin 外观 (controls public pages). */
export async function getSiteAppearance(): Promise<SiteAppearance> {
  await bootDb();
  const siteName = (await getSetting("site_name", "Kaimi")).trim() || "Kaimi";
  const raw = await getSetting("site_theme", "snow");
  const themeId: ThemeId = isThemeId(raw) ? raw : "snow";
  const buyCdkUrl = normalizeExternalUrl(await getSetting("buy_cdk_url", ""));
  const shopEnabled = (await getSetting("shop_enabled", "0")) === "1";
  return { siteName, themeId, buyCdkUrl, shopEnabled };
}

export async function isShopEnabled() {
  return (await getSetting("shop_enabled", "0")) === "1";
}

export async function getStorefront(kind: "shop" | "recharge") {
  await bootDb();
  const appearance = await getSiteAppearance();
  const row = await db.query.storefronts.findFirst({
    where: eq(storefronts.kind, kind),
  });
  const base = row ?? {
    siteName: kind === "shop" ? "Kaimi 发卡网" : "Kaimi 代充店",
    themeId: kind === "shop" ? "aurora" : "snow",
    announcement: "",
    afterSales: "",
    contacts: "",
    icp: "",
    homeBanner: "",
    enabled: true,
  };
  return {
    ...base,
    /** Storefront display title (shop / recharge page H1). */
    siteName: base.siteName || (kind === "shop" ? "Kaimi 发卡网" : "Kaimi 代充店"),
    /** Site-wide brand for header / homepage. */
    brandName: appearance.siteName,
    /** Admin 整站主题 always wins on public pages. */
    themeId: appearance.themeId,
    afterSales: /webhook|轮询|unknown|店主/i.test(base.afterSales || "") ? "" : base.afterSales,
  };
}
