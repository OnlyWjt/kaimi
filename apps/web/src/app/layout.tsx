import type { Metadata } from "next";
import { IBM_Plex_Sans, Sora } from "next/font/google";
import { ToastHost } from "@/components/toast";
import { getSiteAppearance } from "@/lib/storefront";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex",
  display: "swap",
});

async function siteAppearanceOrFallback() {
  try {
    return await getSiteAppearance();
  } catch (error) {
    console.warn("[layout] 读站点外观失败，先用默认主题", error);
    return { siteName: "Kaimi", themeId: "snow" as const, shopEnabled: false };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  // 站点名后台可改，标签页标题跟着它走，别写死。
  const { siteName } = await siteAppearanceOrFallback();
  return {
    title: siteName || "Kaimi",
    description: "卡密兑换开通",
  };
}

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { themeId } = await siteAppearanceOrFallback();

  return (
    <html lang="zh-CN" data-theme={themeId} className={`${sora.variable} ${plex.variable}`}>
      <body style={{ fontFamily: "var(--font-plex), var(--km-font-body), 'PingFang SC', 'Microsoft YaHei', sans-serif" }}>
        {children}
        <ToastHost />
      </body>
    </html>
  );
}
