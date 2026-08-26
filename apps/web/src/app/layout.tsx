import type { Metadata } from "next";
import { IBM_Plex_Sans, Sora } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Kaimi",
  description: "卡密兑换开通",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { themeId } = await getSiteAppearance();

  return (
    <html lang="zh-CN" data-theme={themeId} className={`${sora.variable} ${plex.variable}`}>
      <body style={{ fontFamily: "var(--font-plex), var(--km-font-body), 'PingFang SC', 'Microsoft YaHei', sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
