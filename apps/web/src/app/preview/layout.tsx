import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "代理控制台设计稿",
  description: "静态预览，不连真实数据",
};

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  // 设计稿只在开发环境开放，生产环境 /preview/* 一律 404
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
