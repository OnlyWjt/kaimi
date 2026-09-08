import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentSlugHistory, agentStorefronts, agents } from "@/db/schema";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import {
  pickText,
  rowToSettings,
  type ContactItem,
  type StorefrontSettings,
} from "@/lib/agent-storefront-config";
import { keepSearchPath } from "@/lib/agent-redeem-core";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";
import type { ThemeId } from "@kaimi/themes";

export { keepSearchPath };

export type AgentShopRecord = {
  agent: typeof agents.$inferSelect;
  themeId: ThemeId;
  settings: StorefrontSettings;
};

export type AgentShopChromeData = {
  slug: string;
  shopName: string;
  themeId: ThemeId;
  logoLetter: string;
  announcement: string;
  footerNote: string;
  contacts: ContactItem[];
};

/**
 * 按当前 slug 取店；旧 slug 301 到新地址（keepPath 用来保住 /recharge?code=）。
 */
export async function resolveAgentBySlug(rawSlug: string, keepPath = "") {
  await bootDb();
  const slug = normalizeAgentSlug(rawSlug);
  const agent = await db.query.agents.findFirst({
    where: eq(agents.currentSlug, slug),
  });
  if (agent) return agent;

  const historical = await db.query.agentSlugHistory.findFirst({
    where: eq(agentSlugHistory.slug, slug),
  });
  if (historical) {
    const current = await db.query.agents.findFirst({
      where: eq(agents.id, historical.agentId),
    });
    if (current) redirect(`/s/${current.currentSlug}${keepPath}`);
  }
  notFound();
}

export async function loadAgentShop(rawSlug: string, keepPath = ""): Promise<AgentShopRecord> {
  const agent = await resolveAgentBySlug(rawSlug, keepPath);
  const settingsRow = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agent.id),
  });
  return {
    agent,
    themeId: resolveThemeId(agent.themeId),
    settings: rowToSettings(settingsRow),
  };
}

export function shopChromeFromLoad(shop: AgentShopRecord): AgentShopChromeData {
  const lang = shop.settings.defaultLang;
  const announcement = shop.settings.announcement.enabled
    ? pickText(shop.settings.announcement.text, lang)
    : "";
  return {
    slug: shop.agent.currentSlug,
    shopName: shop.agent.displayName,
    themeId: shop.themeId,
    logoLetter: shop.settings.logoLetter,
    announcement,
    footerNote: pickText(shop.settings.slogan, lang),
    contacts: shop.settings.contacts,
  };
}

export async function loadAgentShopChrome(rawSlug: string, keepPath = "") {
  return shopChromeFromLoad(await loadAgentShop(rawSlug, keepPath));
}
