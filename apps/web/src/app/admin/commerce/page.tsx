import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { CommerceAdmin } from "@/components/commerce-admin";

export default async function AdminCommercePage() {
  await bootDb();
  await requireAdmin();
  return (
    <main className="km-shell-wide space-y-6 py-10">
      <div className="km-page-hero">
        <p className="km-eyebrow">Commerce</p>
        <h1 className="km-page-title">即时发卡配置</h1>
      </div>
      <CommerceAdmin />
    </main>
  );
}
