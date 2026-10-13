import type { Metadata } from "next";
import { AdminShellPreview } from "@/components/admin-shell-preview";

export const metadata: Metadata = {
  title: "后台布局设计稿",
  description: "静态预览，不连真实数据",
};

export default function AdminShellPreviewPage() {
  return (
    <main className="km-admin min-h-screen">
      <AdminShellPreview />
    </main>
  );
}
