import Link from "next/link";
import { dealLine, moneyYuan, type AgentOverviewSnapshot } from "@/lib/agent-console-core";

export function AgentOverview({ snapshot }: { snapshot: AgentOverviewSnapshot }) {
  const unused = snapshot.unusedBacklog;
  const risky = snapshot.riskyCoupon;

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>今天店还好</h1>
          <p>打开后台先看店况，不要先看表格。有风险用一句话点出来，点进去再处理。</p>
        </div>
      </header>
      <div className="km-acp-kpis">
        <div className="km-acp-kpi">
          <span>近 7 天成交</span>
          <strong>{moneyYuan(snapshot.weekGrossCents)}</strong>
          <small>{snapshot.weekOrderCount} 笔已付</small>
        </div>
        <div className="km-acp-kpi">
          <span>待结算</span>
          <strong>{moneyYuan(snapshot.pendingCents)}</strong>
          <small>已扣通道费</small>
        </div>
        <div className="km-acp-kpi">
          <span>未兑换积压</span>
          <strong>{unused}</strong>
          <small>发出去还没人兑</small>
        </div>
        <div className="km-acp-kpi">
          <span>在用的券</span>
          <strong>{snapshot.activeCouponCount}</strong>
          <small>
            {risky ? "有成本提醒，点右边待办" : "按当前售价没有成本提醒"}
          </small>
        </div>
      </div>
      <div className="km-acp-grid2">
        <section className="km-panel">
          <div className="km-acp-section-title">
            <div>
              <h2>最近成交</h2>
              <p>确认店还在出单。明细去账本。</p>
            </div>
            <Link href="/agent/books" className="km-btn km-btn-ghost">
              账本
            </Link>
          </div>
          <div className="km-acp-list">
            {snapshot.deals.map((item) => (
              <div key={item.id} className="km-acp-row">
                <div>
                  <b>{dealLine(item)}</b>
                  <span>{item.orderNo}</span>
                </div>
                <strong>{moneyYuan(item.grossCents)}</strong>
              </div>
            ))}
            {snapshot.deals.length === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">近 7 天还没有成交。</p>
            ) : null}
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
            {risky ? (
              <Link href="/agent/sell" className="km-acp-row km-acp-todo">
                <div>
                  <b>有一张券可能亏本</b>
                  <span>
                    {risky.name} · {risky.message}
                  </span>
                </div>
                <span>去看</span>
              </Link>
            ) : null}
            {unused > 0 ? (
              <Link href="/agent/codes" className="km-acp-row">
                <div>
                  <b>{unused} 张卡还没兑</b>
                  <span>不是库存，是已经卖出的卡</span>
                </div>
                <span>去查</span>
              </Link>
            ) : null}
            {!risky && unused === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">这会儿没有要立刻处理的事。</p>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
