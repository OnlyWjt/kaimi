import { ApplyTheme } from "@/components/apply-theme";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { CdkLookupForm } from "@/components/cdk-lookup-form";
import { getSiteAppearance } from "@/lib/storefront";

export default async function CdkLookupPage() {
  const { siteName, themeId } = await getSiteAppearance();
  return (
    <main data-theme={themeId} className="km-themed-page km-rx">
      <ApplyTheme themeId={themeId} />
      <SiteHeader siteName={siteName} />
      <CdkLookupForm />
      <SiteFooter />
    </main>
  );
}
