import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { getSiteAppearance, getStorefront } from "@/lib/storefront";

const baseFeatures = [
  {
    key: "recharge",
    href: "/recharge",
    title: "开始兑换",
    desc: "校验卡密后，提交 Session 或邮箱密码开通",
    cta: "去兑换",
  },
  {
    key: "buy",
    href: "",
    title: "购买卡密",
    desc: "跳转外部发卡店付款，再回到本站兑换",
    cta: "去购买",
  },
  {
    key: "cdk",
    href: "/cdk",
    title: "卡密查询",
    desc: "查看这张卡是否已使用，以及绑定订单",
    cta: "去查询",
  },
  {
    key: "lookup",
    href: "/lookup",
    title: "订单进度",
    desc: "用订单号查看开通到哪一步",
    cta: "去查单",
  },
] as const;

export default async function HomePage() {
  const appearance = await getSiteAppearance();
  const recharge = await getStorefront("recharge");
  const { themeId: theme, siteName, buyCdkUrl } = appearance;

  const features = baseFeatures
    .filter((f) => f.key !== "buy" || Boolean(buyCdkUrl))
    .map((f) =>
      f.key === "buy"
        ? { ...f, href: buyCdkUrl, external: true as const }
        : { ...f, external: false as const },
    );

  return (
    <main data-theme={theme} className="min-h-screen">
      <SiteHeader siteName={siteName} buyCdkUrl={buyCdkUrl} />

      <section className="km-shell py-16 text-center md:py-20">
        <div className="km-rise mx-auto max-w-2xl space-y-6">
          <p className="km-eyebrow">卡密兑换</p>
          <h1 className="km-page-title" style={{ fontFamily: "var(--font-sora)" }}>
            {siteName}
          </h1>
          <p className="mx-auto max-w-xl text-base leading-relaxed text-[var(--km-fg-muted)]">
            {recharge.announcement || "使用卡密完成账户开通，或查询订单与卡密状态"}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <Link href="/recharge" className="km-btn km-btn-pair">
              开始兑换
            </Link>
            {buyCdkUrl ? (
              <a
                href={buyCdkUrl}
                className="km-btn km-btn-ghost km-btn-pair"
                target="_blank"
                rel="noopener noreferrer"
              >
                购买卡密
              </a>
            ) : null}
          </div>
        </div>
      </section>

      <section
        className={`km-shell grid gap-4 pb-20 ${
          features.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"
        }`}
      >
        {features.map((f, i) => {
          const body = (
            <>
              <h2 className="text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
                {f.title}
              </h2>
              <p className="mt-2 flex-1 text-[0.95rem] leading-relaxed text-[var(--km-fg-muted)]">{f.desc}</p>
              <span className="mt-5 text-sm font-medium">{f.cta} →</span>
            </>
          );
          const className = "km-panel km-panel-hover km-rise flex min-h-[168px] flex-col";
          const style = { animationDelay: `${i * 70}ms` };
          return f.external ? (
            <a key={f.key} href={f.href} className={className} style={style} target="_blank" rel="noopener noreferrer">
              {body}
            </a>
          ) : (
            <Link key={f.key} href={f.href} className={className} style={style}>
              {body}
            </Link>
          );
        })}
      </section>

      <SiteFooter note={recharge.afterSales || undefined} />
    </main>
  );
}
