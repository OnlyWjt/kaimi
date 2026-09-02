import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getSession } from "@/lib/auth";
import { getSiteAppearance } from "@/lib/storefront";

export default async function LoginPage() {
  const session = await getSession();
  if (session) {
    redirect(session.role === "agent" ? "/agent" : "/admin");
  }
  const appearance = await getSiteAppearance();
  return (
    <main data-theme={appearance.themeId} className="min-h-screen">
      <section className="km-shell py-16">
        <LoginForm />
      </section>
    </main>
  );
}
