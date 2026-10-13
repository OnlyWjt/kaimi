"use client";

import { useMemo, useState } from "react";
import { ApplyTheme } from "@/components/apply-theme";
import "./agent-console.css";

type View = "brief" | "home" | "sell" | "coupon" | "books" | "codes" | "shop";

const VIEWS: Array<{ id: View; group: string; label: string; hint: string }> = [
  { id: "brief", group: "设计", label: "为什么这样拆", hint: "产品说明" },
  { id: "home", group: "每天看", label: "概览", hint: "店况" },
  { id: "sell", group: "怎么卖", label: "售价与优惠", hint: "定价" },
  { id: "coupon", group: "怎么卖", label: "做一张券", hint: "新建" },
  { id: "shop", group: "怎么卖", label: "店铺", hint: "装修入口" },
  { id: "books", group: "钱和量", label: "账本", hint: "收益" },
  { id: "codes", group: "钱和量", label: "已售卡密", hint: "售后" },
];

export function AgentConsolePreview() {
  const [view, setView] = useState<View>("brief");
  const [emptyCoupons, setEmptyCoupons] = useState(false);
  const [kind, setKind] = useState<"percent" | "threshold">("percent");
  const [zhe, setZhe] = useState("8");
  const [threshold, setThreshold] = useState("150");
  const [off, setOff] = useState("20");
  const [picked, setPicked] = useState<string[]>(["plus"]);

  const preview = useMemo(() => {
    const list = 150;
    if (kind === "percent") {
      const pay = Math.round((list * Number(zhe || 0)) / 10);
      return { list, pay, discount: list - pay, fee: 7.2, cost: 30, earn: pay - 30 - 7.2 };
    }
    const hit = list >= Number(threshold || 0);
    const discount = hit ? Math.min(Number(off || 0), list) : 0;
    const pay = list - discount;
    return { list, pay, discount, fee: 7.8, cost: 30, earn: pay - 30 - 7.8, missed: !hit };
  }, [kind, zhe, threshold, off]);

  return (
    <div className="km-acp">
      <ApplyTheme themeId="snow" />
      <div className="km-acp-banner">
        <strong>静态设计稿</strong>
        {" · "}
        不连真实接口，点左侧切换页面。看完觉得对，再把现在的代理后台按这个拆。
      </div>
      <div className="km-acp-frame">
        <aside className="km-acp-side">
          <div className="km-acp-brand">
            <strong>onlywjt 的店</strong>
            <small>代理控制台 · 设计稿</small>
          </div>
          <nav className="km-acp-nav" aria-label="设计稿导航">
            {VIEWS.map((item, index) => (
              <div key={item.id}>
                {index === 0 || VIEWS[index - 1].group !== item.group ? (
                  <div className="km-acp-nav-label">{item.group}</div>
                ) : null}
                <button
                  type="button"
                  className={view === item.id ? "is-on" : ""}
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                  <em>{item.hint}</em>
                </button>
              </div>
            ))}
          </nav>
          <div className="km-acp-shopchip">
            <span className="text-xs text-[var(--km-fg-muted)]">店铺一直在手边</span>
            <code>kaimi.example/s/onlywjt</code>
            <div className="km-acp-tools">
              <span className="km-btn km-btn-ghost" style={{ pointerEvents: "none" }}>
                打开
              </span>
              <span className="km-btn km-btn-ghost" style={{ pointerEvents: "none" }}>
                复制
              </span>
            </div>
          </div>
        </aside>

        <div className="km-acp-main">
          {view === "brief" ? <Brief onGo={setView} /> : null}
          {view === "home" ? <Home onGo={setView} /> : null}
          {view === "sell" ? (
            <Sell
              empty={emptyCoupons}
              onToggleEmpty={() => setEmptyCoupons((value) => !value)}
              onCreate={() => setView("coupon")}
            />
          ) : null}
          {view === "coupon" ? (
            <CouponComposer
              kind={kind}
              zhe={zhe}
              threshold={threshold}
              off={off}
              picked={picked}
              preview={preview}
              onKind={setKind}
              onZhe={setZhe}
              onThreshold={setThreshold}
              onOff={setOff}
              onTogglePlan={(key) =>
                setPicked((current) =>
                  current.includes(key)
                    ? current.filter((item) => item !== key)
                    : [...current, key],
                )
              }
              onBack={() => setView("sell")}
            />
          ) : null}
          {view === "shop" ? <Shop /> : null}
          {view === "books" ? <Books /> : null}
          {view === "codes" ? <Codes /> : null}
        </div>
      </div>
    </div>
  );
}

function Brief({ onGo }: { onGo: (view: View) => void }) {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>代理后台按「人要干什么」拆</h1>
          <p>
            现在一页从上滚到下：改主题、改价、建券、看收益、看用量、查卡密。代理每次只想干一件事，却要在同一屏里找。
          </p>
        </div>
      </header>

      <div className="km-panel km-acp-brief">
        <article>
          <h3>代理实际在做的四件事</h3>
          <ol>
            <li>
              <strong>把店开出去</strong>：链接、主题、装修文案。买家认的是店，不是后台表单。
            </li>
            <li>
              <strong>决定怎么卖</strong>：零售价和优惠券是同一件事——今天这个套餐卖多少钱。
            </li>
            <li>
              <strong>看钱有没有到</strong>：成交、手续费、待结算、什么时候打款。
            </li>
            <li>
              <strong>有人来问再查卡</strong>：卡密不是每天扫的，是售后工具。
            </li>
          </ol>
        </article>
        <div className="km-acp-nowthen">
          <section className="now">
            <h4>现在</h4>
            <ul>
              <li>顶栏 7 个同等按钮，主次一样重</li>
              <li>主题在首页，装修在另一页</li>
              <li>优惠券空表单永远摊开，像没做完的后台</li>
              <li>收益和用量各占一长段，数字重复</li>
              <li>卡密列表跟赚钱挤在一起</li>
            </ul>
          </section>
          <section className="then">
            <h4>这版</h4>
            <ul>
              <li>左侧只留 4 个工作面：概览 / 售卖 / 账本 / 卡密</li>
              <li>主题和 slug 并进「店铺」，跟装修住一起</li>
              <li>券先看卡片，要做再进单独一页</li>
              <li>用量收成账本上的漏斗，不再另开一张空表</li>
              <li>兑换、批量、改密放次要工具，不占主列</li>
            </ul>
          </section>
        </div>
        <article>
          <h3>优惠券为什么单独做一页</h3>
          <p>
            券不是「再填几个框」。代理要想：减多少、谁能用、会不会亏、买家看到什么码。把表单钉在列表下面，既不像货架，也不像收银台。做成票面卡片 + 右侧算账，才像在发一张店里的券。
          </p>
        </article>
        <div className="km-acp-tools">
          <button type="button" className="km-btn km-btn-primary" onClick={() => onGo("home")}>
            从概览看起
          </button>
          <button type="button" className="km-btn" onClick={() => onGo("coupon")}>
            先看做券页
          </button>
        </div>
      </div>
    </>
  );
}

function Home({ onGo }: { onGo: (view: View) => void }) {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>今天店还好</h1>
          <p>打开后台先看店况，不要先看表格。有风险用一句话点出来，点进去再处理。</p>
        </div>
        <div className="km-acp-tools">
          <span className="km-btn km-btn-ghost" style={{ pointerEvents: "none" }}>
            打开店铺
          </span>
          <span className="km-btn km-btn-ghost" style={{ pointerEvents: "none" }}>
            兑换
          </span>
        </div>
      </header>
      <div className="km-acp-kpis">
        <div className="km-acp-kpi">
          <span>近 7 天成交</span>
          <strong>¥905.00</strong>
          <small>3 笔已付</small>
        </div>
        <div className="km-acp-kpi">
          <span>待结算</span>
          <strong>¥879.86</strong>
          <small>已扣通道费</small>
        </div>
        <div className="km-acp-kpi">
          <span>未兑换积压</span>
          <strong>5</strong>
          <small>发出去还没人兑</small>
        </div>
        <div className="km-acp-kpi">
          <span>在用的券</span>
          <strong>2</strong>
          <small>1 张有成本提醒</small>
        </div>
      </div>
      <div className="km-acp-grid2">
        <section className="km-panel">
          <div className="km-acp-section-title">
            <div>
              <h2>最近成交</h2>
              <p>确认店还在出单。明细去账本。</p>
            </div>
            <button type="button" className="km-btn km-btn-ghost" onClick={() => onGo("books")}>
              账本
            </button>
          </div>
          <div className="km-acp-list">
            {[
              ["KS20260911003", "Plus ×1", "¥150"],
              ["KS20260911002", "Plus ×1 · 券 NEW8", "¥120"],
              ["KS20260910018", "GPT 成品号", "¥19.90"],
            ].map(([no, name, money]) => (
              <div key={no} className="km-acp-row">
                <div>
                  <b>{name}</b>
                  <span>{no}</span>
                </div>
                <strong>{money}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="km-panel">
          <div className="km-acp-section-title">
            <div>
              <h2>要看一眼的</h2>
              <p>没有待办就留白，不要堆零。</p>
            </div>
          </div>
          <div className="km-acp-list">
            <button type="button" className="km-acp-row km-acp-todo" onClick={() => onGo("sell")}>
              <div>
                <b>有一张券可能亏本</b>
                <span>满 150 减 20 · 用在 Plus 上要复核</span>
              </div>
              <span>去看</span>
            </button>
            <button type="button" className="km-acp-row" onClick={() => onGo("codes")}>
              <div>
                <b>5 张卡还没兑</b>
                <span>不是库存，是已经卖出的卡</span>
              </div>
              <span>去查</span>
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

function Sell({
  empty,
  onToggleEmpty,
  onCreate,
}: {
  empty: boolean;
  onToggleEmpty: () => void;
  onCreate: () => void;
}) {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>今天卖多少钱</h1>
          <p>零售价是底价，优惠券是临时的卖法。两件事放一页，改完心里有数。</p>
        </div>
        <div className="km-acp-tools">
          <button type="button" className="km-btn km-btn-ghost" onClick={onToggleEmpty}>
            {empty ? "看有券的样子" : "看空状态"}
          </button>
          <button type="button" className="km-btn km-btn-primary" onClick={onCreate}>
            做一张券
          </button>
        </div>
      </header>

      <section className="km-panel">
        <div className="km-acp-section-title">
          <div>
            <h2>在售套餐</h2>
            <p>只能填在成本和上限之间。保存一次，全店生效。</p>
          </div>
          <span className="km-btn" style={{ pointerEvents: "none" }}>
            保存售价
          </span>
        </div>
        <table className="km-acp-price">
          <thead>
            <tr>
              <th>套餐</th>
              <th>成本</th>
              <th>可填</th>
              <th>零售价</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["Plus", "¥30.00", "¥30–250", "150.00", "可售"],
              ["Pro", "¥80.00", "¥80–400", "200.00", "可售"],
              ["GPT 成品号", "¥3.00", "¥3–99", "19.90", "有货"],
            ].map((row) => (
              <tr key={row[0]}>
                <td>
                  <b>{row[0]}</b>
                </td>
                <td>{row[1]}</td>
                <td className="text-[var(--km-fg-muted)]">{row[2]}</td>
                <td>
                  <input className="km-input" defaultValue={row[3]} readOnly />
                </td>
                <td>
                  <span className="km-acp-pill">{row[4]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div className="km-acp-section-title">
          <div>
            <h2>店里的券</h2>
            <p>一张票面一张券。停用的变淡，有风险的用提醒标，不把表单摊在下面。</p>
          </div>
        </div>
        {empty ? (
          <div className="km-acp-empty">
            <h3>还没有券</h3>
            <p>有活动再做。空着比永远摊着一个半成品表单更干净。</p>
            <button type="button" className="km-btn km-btn-primary" onClick={onCreate}>
              做第一张券
            </button>
          </div>
        ) : (
          <div className="km-acp-coupons">
            <article className="km-acp-coupon">
              <div className="km-acp-coupon-face">
                <div>
                  <strong>8 折</strong>
                  <small>折扣</small>
                </div>
              </div>
              <div>
                <h3>新客 8 折</h3>
                <div className="meta">
                  券码 <b>NEW8</b> · 已用 3 / 20
                </div>
                <div className="km-acp-chips">
                  <span className="km-acp-chip is-on">Plus</span>
                  <span className="km-acp-chip is-on">Pro</span>
                </div>
              </div>
              <div className="grid justify-items-end gap-2">
                <div className="km-acp-bar" aria-hidden>
                  <i style={{ width: "15%" }} />
                </div>
                <div className="km-acp-tools">
                  <span className="km-btn km-btn-ghost" style={{ pointerEvents: "none" }}>
                    编辑
                  </span>
                  <span className="km-btn km-btn-ghost" style={{ pointerEvents: "none" }}>
                    停用
                  </span>
                </div>
              </div>
            </article>
            <article className="km-acp-coupon">
              <div className="km-acp-coupon-face">
                <div>
                  <strong>−¥20</strong>
                  <small>满 ¥150</small>
                </div>
              </div>
              <div>
                <h3>满 150 减 20</h3>
                <div className="meta">
                  券码 <b>M150</b> · 不限次数
                </div>
                <div className="km-acp-chips">
                  <span className="km-acp-chip is-on">Plus</span>
                  <span className="km-acp-pill warn">Plus 上扣完通道费可能低于成本</span>
                </div>
              </div>
              <div className="grid justify-items-end gap-2">
                <span className="km-acp-pill warn">提醒，不拦</span>
                <div className="km-acp-tools">
                  <button type="button" className="km-btn" onClick={onCreate}>
                    改规则
                  </button>
                </div>
              </div>
            </article>
            <article className="km-acp-coupon is-off">
              <div className="km-acp-coupon-face">
                <div>
                  <strong>9 折</strong>
                  <small>已停用</small>
                </div>
              </div>
              <div>
                <h3>老客 9 折</h3>
                <div className="meta">
                  券码 <b>VIP9</b> · 已用 41 次
                </div>
                <div className="km-acp-chips">
                  <span className="km-acp-chip">GPT 成品号</span>
                </div>
              </div>
              <span className="km-acp-pill mute">停用</span>
            </article>
          </div>
        )}
      </section>
    </>
  );
}

function CouponComposer({
  kind,
  zhe,
  threshold,
  off,
  picked,
  preview,
  onKind,
  onZhe,
  onThreshold,
  onOff,
  onTogglePlan,
  onBack,
}: {
  kind: "percent" | "threshold";
  zhe: string;
  threshold: string;
  off: string;
  picked: string[];
  preview: { list: number; pay: number; discount: number; fee: number; cost: number; earn: number; missed?: boolean };
  onKind: (kind: "percent" | "threshold") => void;
  onZhe: (value: string) => void;
  onThreshold: (value: string) => void;
  onOff: (value: string) => void;
  onTogglePlan: (key: string) => void;
  onBack: () => void;
}) {
  const below = preview.earn < 0;
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>做一张店里的券</h1>
          <p>左边定规则，右边立刻算 Plus 买 1 张会怎样。低于成本只提醒，下单时才硬拦。</p>
        </div>
        <button type="button" className="km-btn km-btn-ghost" onClick={onBack}>
          回到售价与优惠
        </button>
      </header>
      <div className="km-acp-composer">
        <section className="km-panel space-y-5">
          <div className="km-acp-kinds">
            <button
              type="button"
              className={`km-acp-kind${kind === "percent" ? " is-on" : ""}`}
              onClick={() => onKind("percent")}
            >
              <b>折扣</b>
              <span>按几折卖。8 就是买家付原价的 80%。</span>
            </button>
            <button
              type="button"
              className={`km-acp-kind${kind === "threshold" ? " is-on" : ""}`}
              onClick={() => onKind("threshold")}
            >
              <b>满减</b>
              <span>满到门槛再减一笔。适合凑单，不适合无脑砍。</span>
            </button>
          </div>

          <div className="km-acp-fields">
            <label>
              给自己看的名字
              <input className="km-input" defaultValue={kind === "percent" ? "新客 8 折" : "满 150 减 20"} />
            </label>
            <label>
              买家要填的券码
              <input className="km-input font-mono uppercase" defaultValue={kind === "percent" ? "NEW8" : "M150"} />
            </label>
            {kind === "percent" ? (
              <label>
                几折
                <input className="km-input" value={zhe} onChange={(event) => onZhe(event.target.value)} />
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label>
                  满多少元
                  <input
                    className="km-input"
                    value={threshold}
                    onChange={(event) => onThreshold(event.target.value)}
                  />
                </label>
                <label>
                  减多少元
                  <input className="km-input" value={off} onChange={(event) => onOff(event.target.value)} />
                </label>
              </div>
            )}
            <div>
              <p className="mb-2 text-sm">用在哪些套餐</p>
              <div className="km-acp-chips">
                {[
                  ["plus", "Plus"],
                  ["pro", "Pro"],
                  ["finished_gpt", "GPT 成品号"],
                ].map(([key, name]) => (
                  <button
                    key={key}
                    type="button"
                    className={`km-acp-chip${picked.includes(key) ? " is-on" : ""}`}
                    onClick={() => onTogglePlan(key)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" defaultChecked={false} />
              不限次数
            </label>
          </div>

          {below ? (
            <div className="km-acp-warn">
              Plus 用这张券后，扣完通道费会低于成本。可以保存，买家下单时这张券会用不了。
            </div>
          ) : preview.missed ? (
            <div className="km-acp-warn">买 1 张 Plus 还没满门槛，这张券用不上。</div>
          ) : (
            <p className="text-sm text-[var(--km-fg-muted)]">按当前售价，Plus 用这张券不会亏。</p>
          )}

          <div className="km-acp-tools">
            <button type="button" className="km-btn km-btn-primary" onClick={onBack}>
              创建并启用
            </button>
            <button type="button" className="km-btn km-btn-ghost" onClick={onBack}>
              取消
            </button>
          </div>
        </section>

        <aside className="km-acp-ticket">
          <small className="text-[var(--km-fg-muted)]">买家付的时候会看到</small>
          <h3>{kind === "percent" ? `${zhe || "—"} 折` : `减 ¥${off || "0"}`}</h3>
          <code>{kind === "percent" ? "NEW8" : "M150"}</code>
          <dl>
            <div>
              <dt>Plus 原价</dt>
              <dd>¥{preview.list.toFixed(2)}</dd>
            </div>
            <div>
              <dt>优惠</dt>
              <dd>{preview.discount ? `−¥${preview.discount.toFixed(2)}` : "未生效"}</dd>
            </div>
            <div>
              <dt>券后价</dt>
              <dd>¥{preview.pay.toFixed(2)}</dd>
            </div>
            <div>
              <dt>开票实付</dt>
              <dd>¥{(preview.pay * 1.1).toFixed(2)}</dd>
            </div>
            <div>
              <dt>预估收益</dt>
              <dd>¥{preview.earn.toFixed(2)}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </>
  );
}

function Shop() {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>店怎么给人看</h1>
          <p>
            主题、slug、装修文案都是「店」的事。从首页拿掉主题选择器，避免一半在这里、一半在装修页。
          </p>
        </div>
      </header>
      <div className="km-acp-grid2">
        <section className="km-panel space-y-3">
          <h2 className="text-lg font-semibold">这一页只留入口</h2>
          <p className="text-sm leading-6 text-[var(--km-fg-muted)]">
            真实实现时：主题和 slug 并进现有「店铺装修」。首页不再出现色板。代理改完主题，直接在装修页预览。
          </p>
          <div className="km-acp-shopchip">
            <span className="text-xs text-[var(--km-fg-muted)]">当前链接</span>
            <code>https://cdk.example/s/onlywjt</code>
          </div>
          <div className="km-acp-tools">
            <span className="km-btn km-btn-primary" style={{ pointerEvents: "none" }}>
              去装修
            </span>
            <span className="km-btn km-btn-ghost" style={{ pointerEvents: "none" }}>
              打开店铺
            </span>
          </div>
        </section>
        <section className="km-panel space-y-2">
          <h2 className="text-lg font-semibold">不放在这里的</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--km-fg-muted)]">
            <li>改密、退出：右上角账户</li>
            <li>兑换 / 批量兑换：工具，不是店本身</li>
            <li>使用说明：第一次才看，不要跟定价抢位置</li>
          </ul>
        </section>
      </div>
    </>
  );
}

function Books() {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>账本</h1>
          <p>钱和量用同一段时间。上面看赚到没有，中间看单走没走完，下面才是明细。</p>
        </div>
        <div className="km-acp-tools">
          {["今天", "近 7 天", "本月"].map((item, index) => (
            <span key={item} className={index === 1 ? "km-btn" : "km-btn km-btn-ghost"}>
              {item}
            </span>
          ))}
          <span className="km-btn km-btn-ghost">导出</span>
        </div>
      </header>
      <div className="km-acp-kpis">
        <div className="km-acp-kpi">
          <span>成交额</span>
          <strong>¥905.00</strong>
        </div>
        <div className="km-acp-kpi">
          <span>通道费</span>
          <strong>¥2.23</strong>
        </div>
        <div className="km-acp-kpi">
          <span>待结算</span>
          <strong>¥879.86</strong>
        </div>
        <div className="km-acp-kpi">
          <span>券减免</span>
          <strong>¥30.00</strong>
        </div>
      </div>
      <section className="km-panel">
        <div className="km-acp-section-title">
          <div>
            <h2>这段时间的单</h2>
            <p>用量不再另开一页。下单、已付、未兑放在账本里，一眼能对上钱。</p>
          </div>
        </div>
        <div className="km-acp-kpis">
          <div className="km-acp-kpi">
            <span>下单</span>
            <strong>5</strong>
          </div>
          <div className="km-acp-kpi">
            <span>已付</span>
            <strong>3</strong>
          </div>
          <div className="km-acp-kpi">
            <span>已发齐</span>
            <strong>3</strong>
          </div>
          <div className="km-acp-kpi">
            <span>未兑换</span>
            <strong>5</strong>
          </div>
        </div>
      </section>
      <section className="km-panel">
        <div className="km-acp-section-title">
          <div>
            <h2>结算</h2>
            <p>打过款的单独成行，不要和每天的收益表混成一张。</p>
          </div>
        </div>
        <div className="km-acp-row">
          <div>
            <b>ST-202609</b>
            <span>9 月 1 日–9 月 7 日</span>
          </div>
          <div className="text-right">
            <b>¥1,280.00</b>
            <span className="km-acp-pill">待返佣</span>
          </div>
        </div>
      </section>
    </>
  );
}

function Codes() {
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>已售卡密</h1>
          <p>这是售后台，不是库存。买家说没收到，来这里对订单号。</p>
        </div>
      </header>
      <section className="km-panel space-y-4">
        <div className="flex flex-wrap gap-2">
          <input className="km-input max-w-xs" placeholder="订单号" readOnly />
          <span className="km-btn km-btn-ghost">筛选</span>
        </div>
        <table className="km-acp-price">
          <thead>
            <tr>
              <th>卡密</th>
              <th>套餐</th>
              <th>订单</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="font-mono text-xs">AB12****K9</td>
              <td>Plus</td>
              <td className="font-mono text-xs">KS20260911003</td>
              <td>
                <span className="km-acp-pill warn">未兑换</span>
              </td>
            </tr>
            <tr>
              <td className="font-mono text-xs">CD34****M2</td>
              <td>Plus</td>
              <td className="font-mono text-xs">KS20260911002</td>
              <td>
                <span className="km-acp-pill">已兑换</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
