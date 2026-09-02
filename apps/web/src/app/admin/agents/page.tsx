import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminAgents } from "@/components/admin-agents";
import { getSession } from "@/lib/auth";
import { getSiteAppearance } from "@/lib/storefront";

export default async function AdminAgentsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "super_admin") redirect("/agent");
  const appearance = await getSiteAppearance();

  return (
    <main data-theme={appearance.themeId} className="min-h-screen">
      <section className="km-shell-wide space-y-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="km-eyebrow">超级管理员</p>
            <h1 className="km-page-title">代理管理</h1>
          </div>
          <Link href="/admin" className="km-btn km-btn-ghost">
            返回后台
          </Link>
        </header>
        <AdminAgents />
      </section>
    </main>
  );
}
