import { eq } from "drizzle-orm";
import { isThemeId, type ThemeId } from "@kaimi/themes";
import { db } from "@/db";
import { storefronts } from "@/db/schema";
import { getSetting, getSettings } from "@/lib/config";

export type SiteAppearance = {
  siteName: string;
  themeId: ThemeId;
  /** Internal /shop 发卡网开关，默认关闭。 */
  shopEnabled: boolean;
};

export function resolveThemeId(value?: string | null): ThemeId {
  return value && isThemeId(value) ? value : "snow";
}

/** Site-wide brand + theme from admin 外观 (controls public pages). */
export async function getSiteAppearance(): Promise<SiteAppearance> {
  // 每次页面渲染都会走到这里（布局和页面各一次），所以三个配置项一次读完。
  const values = await getSettings(["site_name", "site_theme", "shop_enabled"]);
  return {
    siteName: (values.get("site_name") || "Kaimi").trim() || "Kaimi",
    themeId: resolveThemeId(values.get("site_theme")),
    shopEnabled: values.get("shop_enabled") === "1",
  };
}

export async function isShopEnabled() {
  return (await getSetting("shop_enabled", "0")) === "1";
}

export async function getStorefront(kind: "shop" | "recharge") {
  // getSiteAppearance 内部已经 bootDb 过了。
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
