import Link from "next/link";
import { redirect } from "next/navigation";
import { CardSelectionConfig } from "@/components/card-selection-config";
import { getSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export default async function AdminCardSelectionPage() {
  await bootDb();
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "super_admin") redirect("/agent");

  return (
    <main className="km-shell-wide space-y-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="km-eyebrow">Card platform</p>
          <h1 className="km-page-title">选卡配置</h1>
        </div>
        <Link href="/admin#selection" className="km-btn km-btn-ghost">
          返回后台
        </Link>
      </div>
      <CardSelectionConfig />
    </main>
  );
}
