import { eq } from "drizzle-orm";
import { SiteHeader } from "@/components/site-header";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { getSiteAppearance } from "@/lib/storefront";

export default async function ShopOrderPage({
  params,
}: {
  params: Promise<{ no: string }>;
}) {
  const { no } = await params;
  await bootDb();
  const appearance = await getSiteAppearance();
  const order = await db.query.orders.findFirst({ where: eq(orders.orderNo, no) });
  const codes =
    order && (order.payStatus === "paid" || order.payStatus === "manual")
      ? (JSON.parse(order.deliveredCodesJson || "[]") as string[])
      : [];

  return (
    <main data-theme={appearance.themeId} className="min-h-screen pb-16">
      <SiteHeader siteName={appearance.siteName} buyCdkUrl={appearance.buyCdkUrl} />
      <section className="km-shell">
        <div className="km-page-hero km-rise">
          <p className="km-eyebrow">订单详情</p>
          <h1 className="km-page-title">订单 {no}</h1>
        </div>
        <div className="km-panel km-rise mx-auto max-w-[520px] space-y-4">
          {!order ? (
            <p>未找到订单</p>
          ) : (
            <>
              <p className="text-[var(--km-fg-muted)]">
                支付：{order.payStatus} · 履约：{order.fulfillStatus}
              </p>
              {codes.length ? (
                <div className="space-y-2">
                  <p className="font-medium">卡密（请妥善保存）</p>
                  <ul className="space-y-1 font-mono text-sm">
                    {codes.map((c) => (
                      <li key={c} className="rounded-lg bg-[var(--km-bg-muted)] px-3 py-2">
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-[var(--km-fg-muted)]">尚未发码或未支付。</p>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
