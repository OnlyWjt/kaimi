"use client";

type GuideTab = "overview" | "orders" | "cdks" | "purchase" | "integration" | "appearance";

const SECTIONS = [
  { id: "flow", title: "怎么跑起来" },
  { id: "setup", title: "第一次开店" },
  { id: "customer", title: "客户怎么用" },
  { id: "daily", title: "日常怎么管" },
  { id: "status", title: "状态对照" },
  { id: "faq", title: "出问题怎么办" },
] as const;

export function AdminGuide({ onGo }: { onGo: (tab: GuideTab) => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <nav className="km-panel !p-3" aria-label="说明目录">
          <p className="px-2 pb-2 text-xs text-[var(--km-fg-muted)]">目录</p>
          <ul className="space-y-0.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#guide-${s.id}`} className="km-nav-link block !justify-start">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="space-y-4">
        <section id="guide-flow" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            怎么跑起来
          </h2>
          <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
            Kaimi 是你自己的兑换门户。货和开通在主站 danewcdk，本站负责收卡密、提交开通、给客户查进度。
          </p>
          <ol className="km-guide-steps">
            <li>客户在外部发卡店买到卡密</li>
            <li>回到本站「开始兑换」，校验卡密后提交 Session 或邮箱密码</li>
            <li>本站把开通请求交给主站，客户用订单号查进度</li>
          </ol>
          <p className="text-sm text-[var(--km-fg-muted)]">
            内部发卡页默认关着，只作调试。日常卖卡用「外观」里的购买外链。
          </p>
        </section>

        <section id="guide-setup" className="km-panel space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
              第一次开店
            </h2>
            <button className="km-btn km-btn-ghost" onClick={() => onGo("integration")}>
              去接入
            </button>
          </div>
          <ol className="km-guide-steps">
            <li>
              在「接入 danewcdk」填主站地址、API Key、Webhook 签名，再填本站公网地址。
            </li>
            <li>把页面上的 Webhook 回调复制到主站代理设置，然后点连通检测。</li>
            <li>同步套餐和库存。没有库存就去「进货」向主站下单，付完再同步。</li>
            <li>
              到「外观」改站点名、主题，填购买卡密外链。兑换页公告和页脚说明也可在这里改。
            </li>
          </ol>
          <p className="text-sm text-[var(--km-fg-muted)]">
            Webhook 签名必须填。空签名会被拒绝，开通结果就只能靠本站轮询。
          </p>
        </section>

        <section id="guide-customer" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            客户怎么用
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">购买卡密</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">跳转你配置的外链付款，拿到完整卡密后再回本站。</p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">开始兑换</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                先校验卡密识别套餐。Session 必须预检通过才会出现「提交兑换」；也可以改用邮箱密码。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">订单进度</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">用订单号查看开通到哪一步。处理中会自动刷新。</p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">卡密查询</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">输入完整卡密，看是否已使用、绑了哪笔订单。</p>
            </div>
          </div>
        </section>

        <section id="guide-daily" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            日常怎么管
          </h2>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <GuideJump title="总览" onClick={() => onGo("overview")}>
              看可用库存、卡住的锁、进行中的开通。
            </GuideJump>
            <GuideJump title="订单查询" onClick={() => onGo("orders")}>
              按订单号、邮箱、卡密后四位筛。未结束的单可「重拉」，也可导出 CSV。
            </GuideJump>
            <GuideJump title="卡密查询" onClick={() => onGo("cdks")}>
              默认脱敏，点「显示」后再复制。可核销、禁用、启用，或从主站同步。
            </GuideJump>
            <GuideJump title="进货" onClick={() => onGo("purchase")}>
              向主站下单补货，支付宝或微信。付完后回来同步库存。
            </GuideJump>
          </div>
          <p className="text-sm text-[var(--km-fg-muted)]">
            服务端每分钟会轮询未结束订单，并对卡住的锁做对账。总览或订单页也可以手动点一次。
          </p>
        </section>

        <section id="guide-status" className="km-panel space-y-4">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            状态对照
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium">卡密</p>
              <table className="km-table">
                <colgroup>
                  <col style={{ width: "32%" }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>含义</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>未使用</td>
                    <td>可以拿去兑换</td>
                  </tr>
                  <tr>
                    <td>占用中</td>
                    <td>开通进行中，先别动</td>
                  </tr>
                  <tr>
                    <td>已售出</td>
                    <td>已交给客户，不再拿去开通</td>
                  </tr>
                  <tr>
                    <td>已核销</td>
                    <td>开通完成或已作废</td>
                  </tr>
                  <tr>
                    <td>已禁用</td>
                    <td>作废，客户校验会失败</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">订单</p>
              <table className="km-table">
                <colgroup>
                  <col style={{ width: "32%" }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>含义</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>排队中 / 处理中</td>
                    <td>主站还在开通，等回调或轮询</td>
                  </tr>
                  <tr>
                    <td>成功 / 已完成</td>
                    <td>终态，账号应已开通</td>
                  </tr>
                  <tr>
                    <td>失败</td>
                    <td>开通没成，锁应被释放或核销</td>
                  </tr>
                  <tr>
                    <td>未知</td>
                    <td>结果对不上，不要重复提交，先重拉</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="guide-faq" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            出问题怎么办
          </h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="font-medium">客户说卡密无效</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                到「卡密查询」看状态。已禁用、已核销、占用中都不能再兑。库存对账只动「未使用」，不会误伤已售出。
              </dd>
            </div>
            <div>
              <dt className="font-medium">订单一直处理中</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                先确认 Webhook 回调已填到主站。再到订单页「重拉」或「轮询进行中」。总览有未结束单时也会提示。
              </dd>
            </div>
            <div>
              <dt className="font-medium">失败了但卡还锁着</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                点「修复卡住的锁」。失败且未消耗的码会回到未使用；已经用掉的会标成已核销。
              </dd>
            </div>
            <div>
              <dt className="font-medium">Session 预检过不了</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                让客户打开 chatgpt.com/api/auth/session，复制整页 JSON。预检必须走主站通过后才能提交。
              </dd>
            </div>
            <div>
              <dt className="font-medium">想收到开通结果通知</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                在接入页填终态通知地址，或 Telegram Token 和 Chat ID。只有成功、失败这类终态才会推。
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

function GuideJump({
  title,
  children,
  onClick,
}: {
  title: string;
  children: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-left">
      <p className="font-medium">{title} →</p>
      <p className="mt-1 text-[var(--km-fg-muted)]">{children}</p>
    </button>
  );
}
