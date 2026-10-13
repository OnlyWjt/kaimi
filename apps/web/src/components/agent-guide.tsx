"use client";

import { useEffect, useState } from "react";

const SECTIONS = [
  { id: "how", title: "你是怎么赚钱的" },
  { id: "start", title: "开店三步" },
  { id: "customer", title: "客户怎么买" },
  { id: "desk", title: "后台几个按钮" },
  { id: "money", title: "收益怎么算" },
  { id: "settle", title: "如何结算" },
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
            你有一个自己的店铺页面。平台给你成本价，有的套餐还会设零售价上限。你在这个区间里定价，差价减去这一笔支付的手续费就是你的收益。
          </p>
          <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
            客户付款后，系统会自动生成新卡密，一张单可以买多张。不用你囤货，也不用你垫钱进货。你只要把店铺链接发出去。
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
              第一次登录先在左侧点「修改密码」。再进「店铺」挑主题、改链接和店名，一定要点保存。
            </li>
            <li>
              在「售价与优惠」把售价填进旁边的「可填区间」：不能低于成本，也不能超过平台上限。没填、填出区间，或显示「平台暂时缺货」，客户都看不到这个套餐。
            </li>
            <li>把店铺链接发给客户。收款、出卡密、兑换都是客户自助，不用你手动发货。</li>
          </ol>
          <p className="text-sm text-[var(--km-fg-muted)]">
            改店铺名之后旧链接还能用，会自动跳到新的。已经高于上限的老价格仍按原价卖，但你再保存时必须改回区间内。
          </p>
        </section>

        <section id="agent-guide-customer" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">客户怎么买</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">1. 下单付款</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                打开你的店铺链接，选套餐，可一次买多张，填自己的邮箱，用支付宝或微信付款。多人同时买互不影响。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">2. 自动拿到卡密</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                付完款页面会出卡密和兑换链接。买多张时可能先出一部分，其余会继续出现在同一页，让客户别重复付款。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">3. 客户自己兑换</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                点「去兑换」，校验卡密后填账号信息提交。提交后马上有订单号，开通在后面继续跑。多张卡会带进批量兑换，填一次账号一起开。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">卡密弄丢了怎么办</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                让他回店铺页查单。只填下单邮箱只能看到订单状态，看不到卡密；要看卡密，得再输入完整订单号（在发货邮件或支付宝/微信账单的「商户单号」里），或者点「把查单链接发到这个邮箱」去邮箱里点开。你也可以在「订单」里按他的邮箱找到这一单，点「复制查单链接」发给他。
              </p>
            </div>
          </div>
        </section>

        <section id="agent-guide-desk" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">后台几个按钮</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">订单</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                店里每一笔单都在这里，按订单号或买家邮箱能搜。「待处理」是付了款还没发齐的单，后面写着该怎么跟客户说。能复制查单链接给客户，也能重发发货邮件。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">通知</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                绑定 Telegram 后，每笔付款都会推给你；付款 10 分钟还没发出卡的单也会单独提醒一次，让你在客户找上门前就知道。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">打开店铺</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                用客户的视角看你的店，改完主题或价格后先自己点开确认。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">兑换卡密</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                进本站兑换页，给手上只有一张码的客户用。提交后立刻回订单号，不用等卡台跑完。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">批量兑换</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                把卡密粘进去，填一次账号一起开。只兑你手动粘的码，不会读取「已售卡密」。已卖给客户的码不要自己兑。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">修改密码</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                改完立刻生效，已经登录的其他设备会被退出。平台重置你的密码时也一样。
              </p>
            </div>
          </div>
        </section>

        <section id="agent-guide-money" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">收益怎么算</h2>
          <p className="text-sm text-[var(--km-fg-muted)]">
            一笔订单的收益 = 零售价 × 张数 − 成本 × 张数 − 这一笔支付的手续费。手续费是支付宝/微信收的，一单收一次，不随张数翻倍。
          </p>
          <p className="text-sm text-[var(--km-fg-muted)]">
            客户勾选开票后，实付会再上浮 10%（开票服务费）。这笔加价归平台、不计入你的佣金；发票金额和收益都按折后货款算，加价上多出来的通道费也归平台。
          </p>
          <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
            <p className="font-medium">举个例子</p>
            <p className="mt-1 text-[var(--km-fg-muted)]">
              成本 120 元，你挂 130 元，客户买 2 张，手续费 0.91 元，这笔你赚 19.09 元。
            </p>
          </div>
          <p className="text-sm text-[var(--km-fg-muted)]">
            「账本」可以切今天、近 7 天、本月、全部，也能导出 Excel。手续费按下单当时的费率算，之后不会再变。
          </p>
        </section>

        <section id="agent-guide-settle" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">如何结算</h2>
          <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
            客户支付的款项进入平台账户。发卡完成后，商店收益立即记入「账本」。若已开通自助提卡，未结算的提卡是你应付平台的金额。
          </p>
          <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
            未结净额 = 商店收益 + 调整 − 未结提卡。大于 0 时平台付给你，小于 0 时你付给平台，等于 0 时双方抵平。账本顶部的未结金额与平台对账页一致。
          </p>
          <ol className="km-guide-steps">
            <li>不按自然周自动打款。需要结算时联系平台，并在「账本」核对当前未结净额。</li>
            <li>线下转账完成后，由平台登记「已结算」。代理不能自行结算。</li>
            <li>登记之后，已纳入的明细结清，新的订单和提卡重新累计。此后的退款或手续费差额记入下一次未结。</li>
          </ol>
        </section>

        <section id="agent-guide-faq" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">客户问你怎么答</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="font-medium">「我付了钱，没看到卡密」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                先在「订单」里按他的邮箱搜到这一单，看状态。「发货中」「部分发货」等一下就好，买多张时会先出一部分；「待补货」是暂时没货，补上后自动发；「发货待核实」是平台在人工核对，会补发。这几种都别让客户重复付款。已发货的，点「复制查单链接」发给他，或者「重发邮件」。超过十几分钟还卡着，把订单号发给平台。
              </dd>
            </div>
            <div>
              <dt className="font-medium">「没收到发货邮件」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                先让他看垃圾箱。还没有就在「订单」里点「重发邮件」，同一单 2 分钟能点一次。提示没发出时，多半是平台没开订单邮件，或你在「通知」里关了发货邮件，这时直接复制查单链接给他。
              </dd>
            </div>
            <div>
              <dt className="font-medium">「卡密用不了 / 说无效」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                先在「已售卡密」里看状态。如果是「已使用」或「兑换中」，说明已经兑过或正在开，问他是不是之前点过。其他情况找平台。
              </dd>
            </div>
            <div>
              <dt className="font-medium">「兑换一直在转 / 提示核对中」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                提交成功就会有订单号，开通在后面跑，不用再点一次。显示「核对中」或「结果待确认」时禁止重提，可能已经扣过费了，把订单号发给平台。
              </dd>
            </div>
            <div>
              <dt className="font-medium">「能便宜点吗」</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                零售价你自己改，也可以在「售价与优惠」做一张券。改价和券都只影响之后的新订单，已经付过款的不会变。券后价扣完通道费不能低于成本，否则下单时这张券用不了。
              </dd>
            </div>
            <div>
              <dt className="font-medium">我的收益怎么比想的少</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                收益是扣掉成本和这一笔支付手续费之后的净额。买多张时，差价按张数乘，手续费仍只扣一次。点开「账本」明细能看到每笔怎么拆的。
              </dd>
            </div>
            <div>
              <dt className="font-medium">某个套餐客户说看不到</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                看「售价与优惠」的状态。没填、填出区间、平台没给你开，或显示「平台暂时缺货」，客户都看不到。
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
