import Link from "next/link";
import { dealLine, moneyYuan, type AgentOverviewSnapshot } from "@/lib/agent-console-core";

export function AgentOverview({ snapshot }: { snapshot: AgentOverviewSnapshot }) {
  const unused = snapshot.unusedBacklog;
  const risky = snapshot.riskyCoupon;

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>经营概览</h1>
          <p>先查看经营概况。有待处理事项时会标出，可进入对应页面处理。</p>
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
          <small>已发卡、尚未兑换</small>
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
              <p>近期成交。明细见账本。</p>
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
              <h2>待处理</h2>
              <p>没有待办时此处留空。</p>
            </div>
          </div>
          <div className="km-acp-list">
            {risky ? (
              <Link href="/agent/sell" className="km-acp-row km-acp-todo">
                <div>
                  <b>有优惠券可能低于成本</b>
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
                  <b>{unused} 张卡尚未兑换</b>
                  <span>已售出，不是库存</span>
                </div>
                <span>去查</span>
              </Link>
            ) : null}
            {!risky && unused === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">当前没有待处理事项。</p>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
