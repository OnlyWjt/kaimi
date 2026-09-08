import { Suspense } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { OrderLookupForm } from "@/components/order-lookup-form";
import { getSiteAppearance } from "@/lib/storefront";

export default async function LookupPage() {
  const { siteName, themeId } = await getSiteAppearance();
  return (
    <main data-theme={themeId} className="km-themed-page km-rx">
      <ApplyTheme themeId={themeId} />
      <SiteHeader siteName={siteName} />
      <Suspense
        fallback={
          <div className="km-shell-narrow py-10">
            <div className="km-panel">加载中…</div>
          </div>
        }
      >
        <OrderLookupForm />
      </Suspense>
      <SiteFooter />
    </main>
  );
}
