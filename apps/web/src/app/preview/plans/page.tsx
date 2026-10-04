import type { Metadata } from "next";
import { PlanPricesPreview } from "@/components/plan-prices-preview";

export const metadata: Metadata = {
  title: "默认成本价设计稿",
  description: "静态预览，不连真实数据",
};

export default function PlanPricesPreviewPage() {
  return (
    <main className="km-admin min-h-screen">
      <PlanPricesPreview />
    </main>
  );
}
