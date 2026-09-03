"use client";

type GuideTab =
  | "overview"
  | "orders"
  | "cdks"
  | "integration"
  | "selection"
  | "commerce"
  | "agents"
  | "appearance";

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
            Kaimi 是多代理即时发卡门户：客户在代理店铺付款，平台向卡台生成一张新卡密，客户再回本站兑换开通。
          </p>
          <ol className="km-guide-steps">
            <li>接好卡台和易支付，填可被外网访问的本站地址，再给代理分配可售套餐</li>
            <li>客户打开 /s/店铺名，选套餐、填自己的邮箱、付款</li>
            <li>到账后本页会显示「正在生成卡密」；出码后出现卡密和兑换链接，点「去兑换」即可</li>
          </ol>
          <p className="text-sm text-[var(--km-fg-muted)]">
            易支付必须能访问你的公网地址。填 localhost，支付成功也不会回调、不会发卡。
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
              在「接入卡台」加主台/备台、填协议和 Key，把出口 IP 加进卡台白名单；再到「选卡配置」设优先级和兑换策略。
            </li>
            <li>
              到「即时发卡」填本站公网地址（https://你的域名，不要 localhost）、易支付网关/PID/密钥和手续费。保存后看一眼异步通知地址，应是
              公网域名/api/webhooks/epay。
            </li>
            <li>
              到「代理管理」设套餐默认成本，创建代理并勾选可售套餐。代理用 /login 登录后，自己改零售价和店铺主题。
            </li>
            <li>
              到「外观」改整站名和默认主题。代理店铺主题由代理自己选，兑换页公告也可在外观里改。
            </li>
          </ol>
          <p className="text-sm text-[var(--km-fg-muted)]">
            兑换走卡台 public CDK 接口，不再对接 danewcdk Agent。付款发码会带选卡偏好。
          </p>
        </section>

        <section id="guide-customer" className="km-panel space-y-3">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            客户怎么用
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">购买卡密</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                打开代理给的 /s/店铺名。选套餐，填自己的接收邮箱，选支付宝或微信后付款。多人同时买互不影响。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">拿卡密 / 查自己的单</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                支付完成页会转圈等待出码，好了会显示卡密和兑换链接。换设备时，在店铺页用当时填的邮箱点「用邮箱查询我的订单」。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">开始兑换</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                点兑换链接会带上卡密。先校验识别套餐；Session 预检通过后才能提交，也可以改用邮箱密码。
              </p>
            </div>
            <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
              <p className="font-medium">订单进度 / 卡密查询</p>
              <p className="mt-1 text-[var(--km-fg-muted)]">
                开通进度用兑换订单号查。卡密查询输入完整卡密，看是否已使用。
              </p>
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
              这里列的是店铺已经售出的卡密，不是旧库存池。默认脱敏，点「显示」后再复制。可核销、禁用、启用。
            </GuideJump>
            <GuideJump title="接入卡台" onClick={() => onGo("integration")}>
              多账户、协议、Webhook 和出口 IP。客户付款后由卡台即时发码。
            </GuideJump>
            <GuideJump title="选卡配置" onClick={() => onGo("selection")}>
              产品在线状态、自动选卡优先级、本站兑换策略和卡健康。
            </GuideJump>
            <GuideJump title="即时发卡" onClick={() => onGo("commerce")}>
              公网地址、易支付、店铺订单、复制查单链接、返佣结算。已发卡订单即可生成结算单。
            </GuideJump>
            <GuideJump title="代理管理" onClick={() => onGo("agents")}>
              新建代理、默认成本、弹窗勾选套餐。代理从 /login 登录后改零售价和店铺主题。
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
              <p className="mb-2 text-sm font-medium">店铺订单</p>
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
                    <td>未支付</td>
                    <td>还没到账，或易支付回调没打到公网地址</td>
                  </tr>
                  <tr>
                    <td>已支付 / 发卡中</td>
                    <td>钱已到，正在向卡台要卡密，客户页会转圈等待</td>
                  </tr>
                  <tr>
                    <td>已发卡</td>
                    <td>卡密已生成，可进结算；客户可用邮箱再查回</td>
                  </tr>
                  <tr>
                    <td>已付未发</td>
                    <td>卡台发码失败，可在即时发卡里重试发卡</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">兑换订单</p>
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
                    <td>卡台还在开通，等轮询 result</td>
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
              <dt className="font-medium">付了款但没有卡密 / 提示订单不存在</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                先看易支付通知地址是不是 localhost。必须填公网地址并保存。客户回到订单页会自动确认到账并调卡台；出码前会显示「正在生成卡密」。后台也可点「重试发卡」或「复制查单链接」发给客户。
              </dd>
            </div>
            <div>
              <dt className="font-medium">两个人同时买，怎么查自己的单</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                店铺页用各自填写的接收邮箱点「用邮箱查询我的订单」，只列出这个邮箱在本店的单。不要用「最近一笔」这种按浏览器记的方式。
              </dd>
            </div>
            <div>
              <dt className="font-medium">生成结算单是空的</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                只有已支付且已发卡的订单会进结算。日期用付款当天所在周期。易支付查手续费失败（例如 No Act）时按后台费率估算，不再卡住结算单。金额是售价减成本和手续费，不是整笔售价。
              </dd>
            </div>
            <div>
              <dt className="font-medium">复制查单链接报错</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                用 http://IP 打开后台时，浏览器可能没有剪贴板权限。现在会自动改用兼容复制；还是失败会弹出链接，手动拷即可。
              </dd>
            </div>
            <div>
              <dt className="font-medium">客户说卡密无效</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                到「卡密查询」看状态。已禁用、已核销、占用中都不能再兑。库存对账只动「未使用」，不会误伤已售出。
              </dd>
            </div>
            <div>
              <dt className="font-medium">兑换订单一直处理中</dt>
              <dd className="mt-1 text-[var(--km-fg-muted)]">
                到订单页「重拉」或「轮询进行中」，本站会向卡台拉兑换进度。总览有未结束单时也会提示。
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
                让客户打开 chatgpt.com/api/auth/session，复制整页 JSON。预检必须走卡台 preflight 通过后才能提交。
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
