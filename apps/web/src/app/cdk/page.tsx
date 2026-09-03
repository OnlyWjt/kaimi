import { SiteFooter, SiteHeader } from "@/components/site-header";
import { CdkLookupForm } from "@/components/cdk-lookup-form";
import { getSiteAppearance } from "@/lib/storefront";

export default async function CdkLookupPage() {
  const { siteName, themeId } = await getSiteAppearance();
  return (
    <main data-theme={themeId} className="min-h-screen">
      <SiteHeader siteName={siteName} />
      <CdkLookupForm />
      <SiteFooter />
    </main>
  );
}
