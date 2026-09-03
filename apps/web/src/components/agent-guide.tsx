"use client";

import { useEffect, useState } from "react";

const SECTIONS = [
  { id: "how", title: "你是怎么赚钱的" },
  { id: "start", title: "开店三步" },
  { id: "customer", title: "客户怎么买" },
  { id: "money", title: "收益怎么算" },
  { id: "settle", title: "什么时候拿到钱" },
  { id: "faq", title: "客户问你怎么答" },
] as const;

export function AgentGuide({ slug }: { slug: string }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const shopUrl = origin ? `${origin}/s/${slug}` : `/s/${slug}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <nav className="km-panel !p-3" aria-label="说明目录">
          <p className="px-2 pb-2 text-xs text-[var(--km-fg-muted)]">目录</p>
          <ul className="space-y-0.5">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#agent-guide-${section.id}`}
                  className="km-nav-link block !justify-start"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="space-y-4">
        <section id="agent-guide-how" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">你是怎么赚钱的</h2>
          <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
            你有一个自己的店铺页面。平台给你一个成本价，你自己定挂出去的零售价，差价减掉支付手续费就是你的收益。
          </p>
          <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
            客户付款后，系统会自动生成一张全新的卡密给他，不用你手动发货，也不用你垫钱进货。你只要把店铺链接发出去。
          </p>
          <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
            <p className="font-medium">你的店铺链接</p>
            <p className="mt-1 break-all text-[var(--km-fg-muted)]">{shopUrl}</p>
            <p className="mt-2 text-[var(--km-fg-muted)]">
              这个链接就是你的全部生意，发朋友圈、发群里、放主页签名都可以。
            </p>
          </div>
        </section>

        <section id="agent-guide-start" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">开店三步</h2>
          <ol className="km-guide-steps">
            <li>
              在「店铺外观与链接」挑一个主题，改一个好记的店铺名（链接里那一段）。改完一定要点「保存店铺设置」，不然不生效。
            </li>
            <li>
              在「店铺零售价」把每个套餐的售价填上。必须高于旁边的成本价，否则这个套餐会显示不可售，客户看不到。
            </li>
            <li>把店铺链接发给客户。剩下的收款和发卡都是自动的。</li>
          </ol>
          <p className="text-sm text-[var(--km-fg-muted)]">
            改店铺名之后旧链接还能用，会自动跳到新的，已经发出去的链接不会失效。
          </p>
        </section>

        <section id="agent-guide-customer" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">客户怎么买</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">1. 下单付款</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                打开你的店铺链接，选套餐，填自己的邮箱，用支付宝或微信付款。多个客户同时买互不影响。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">2. 自动拿到卡密</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                付完款页面会等几秒，然后直接显示卡密和兑换链接。这一步不需要你做任何事。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">3. 客户自己兑换</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                点兑换链接，按页面提示填自己的账号信息，提交后等开通完成。整个过程客户自助。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">卡密弄丢了怎么办</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                让他回你的店铺页，用下单时填的那个邮箱查自己的订单，卡密能重新看到。你也能在「我的卡密」里帮他查。
              </p>
            </div>
          </div>
        </section>

        <section id="agent-guide-money" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">收益怎么算</h2>
          <p className="text-sm text-[var(--km-fg-muted)]">
            一笔订单的收益 = 你的零售价 − 平台成本价 − 支付手续费。手续费是支付宝/微信那边收的，不是平台收的。
          </p>
          <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
            <p className="font-medium">举个例子</p>
            <p className="mt-1 text-[var(--km-fg-muted)]">
              成本 120 元，你挂 130 元，手续费 0.91 元，这笔你赚 9.09 元。
            </p>
          </div>
          <p className="text-sm text-[var(--km-fg-muted)]">
            「收益」那一栏可以切今天、近 7 天、本月、全部，也能导出 Excel 自己对账。手续费按下单当时的费率算，之后不会再变。
          </p>
        </section>

        <section id="agent-guide-settle" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">什么时候拿到钱</h2>
          <p className="text-sm text-[var(--km-fg-muted)]">
            客户付的钱先进平台的收款账户，平台按周期把你的收益结给你。你不用自己申请。
          </p>
          <ol className="km-guide-steps">
            <li>订单付款成功并且卡密已经发出去，这笔收益就算「待结算」。</li>
            <li>平台按周期出一张结算单，状态是「待返佣」，金额就是这段时间你的收益合计。</li>
            <li>平台实际打款给你之后，结算单变成「已返佣」，并会记下打款方式和流水号。</li>
          </ol>
          <p className="text-sm text-[var(--km-fg-muted)]">
            在「返佣结算记录」里能看到每一张结算单和它的状态。
          </p>
        </section>

        <section id="agent-guide-faq" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">客户问你怎么答</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="font-medium">「我付了钱，没看到卡密」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                先让他回店铺页用下单邮箱查订单。如果显示还在处理，稍等一下再刷新。超过几分钟还没有，把订单号发给平台管理员，别让客户重复付款。
              </dd>
            </div>
            <div>
              <dt className="font-medium">「卡密用不了 / 说无效」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                先在「我的卡密」里查这张的状态。如果是「已使用」，说明已经兑换过了，问他是不是之前兑过。其他情况找平台管理员。
              </dd>
            </div>
            <div>
              <dt className="font-medium">「能便宜点吗」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                零售价你自己说了算，随时能改，但不能低于成本价。改价只影响之后的新订单，已经付过款的订单不会变。
              </dd>
            </div>
            <div>
              <dt className="font-medium">我的收益怎么比想的少</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                收益是扣掉成本和支付手续费之后的净额，不是客户付的那个总数。点开「收益」里的明细能看到每笔的成本和手续费各是多少。
              </dd>
            </div>
            <div>
              <dt className="font-medium">某个套餐客户说看不到</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                看「店铺零售价」里那个套餐的状态。零售价没填、填得比成本低，或者平台暂时没给你开这个套餐，客户都看不到。
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
