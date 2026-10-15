"use client";

import { Fragment, useState } from "react";
import { AgentDrawPreview, AgentEarningsPreview, AgentManagePreview } from "@/components/admin-agent-desk-preview";
import {
  AnnouncementsPreview,
  ApiKeysPreview,
  AppearancePreview,
  CdkPreview,
  CommercePreview,
  FinishedPreview,
  GuardPreview,
  GuidePreview,
  IntegrationPreview,
  OrdersPreview,
  OverviewPreview,
  SelectionPreview,
  UsagePreview,
} from "@/components/admin-desk-rest-preview";

const GROUPS = [
  {
    id: "daily",
    name: "日常",
    items: [
      ["overview", "总览"],
      ["orders", "订单"],
      ["cdks", "卡密"],
      ["usage", "用量"],
    ],
  },
  {
    id: "sell",
    name: "卖卡",
    items: [
      ["commerce", "即时发卡"],
      ["finished", "成品号"],
      ["selection", "选卡配置"],
    ],
  },
  {
    id: "agent",
    name: "代理",
    items: [
      ["agents", "代理管理"],
      ["draw", "提卡账本"],
      ["week", "历史周结"],
      ["earnings", "收益统计"],
    ],
  },
  {
    id: "system",
    name: "系统",
    items: [
      ["integration", "接入卡台"],
      ["guard", "兑换拦截"],
      ["apikeys", "开放 API"],
      ["announcements", "公告"],
      ["appearance", "外观"],
      ["guide", "使用说明"],
    ],
  },
] as const;

type Screen = (typeof GROUPS)[number]["items"][number][0];

const WEEKS = [
  { id: "1005", label: "09-29 ～ 10-05", state: "已生成" },
  { id: "0928", label: "09-22 ～ 09-28", state: "已打完" },
  { id: "now", label: "10-06 ～ 10-12", state: "进行中" },
];

const PAYOUTS = [
  { agent: "HelloAI", orders: 18, goods: "¥1,860.00", fee: "¥27.90", earn: "¥227.26", paid: false },
  { agent: "huyazhou", orders: 6, goods: "¥420.00", fee: "¥6.30", earn: "¥48.10", paid: false },
  { agent: "Polus", orders: 2, goods: "¥148.50", fee: "¥2.20", earn: "¥7.05", paid: true },
  { agent: "小浣熊的店", orders: 1, goods: "¥115.00", fee: "¥1.73", earn: "¥9.09", paid: true },
];

function groupOf(screen: Screen) {
  return GROUPS.find((group) => group.items.some((item) => item[0] === screen)) || GROUPS[0];
}

export function AdminShellPreview() {
  const [screen, setScreen] = useState<Screen>("agents");
  const group = groupOf(screen);

  return (
    <div className="min-h-screen">
      <header className="km-header">
        <div className="km-shell-wide space-y-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="km-brand">
              <span className="km-brand-mark" aria-hidden>
                A
              </span>
              <div>
                <div className="km-brand-name">Kaimi Admin</div>
                <p className="text-xs text-[var(--km-fg-muted)]">静态稿 · 不连真实数据</p>
              </div>
            </div>
            <div className="flex gap-2">
              <span className="km-btn km-btn-ghost">前台</span>
              <span className="km-btn km-btn-ghost">代理登录</span>
              <span className="km-btn km-btn-ghost">退出</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {GROUPS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`rounded-full px-3 py-1 text-sm ${group.id === item.id ? "bg-[var(--km-fg)] text-[var(--km-bg)]" : "bg-[var(--km-bg-muted)]"}`}
                onClick={() => setScreen(item.items[0][0])}
              >
                {item.name}
              </button>
            ))}
          </div>
          <nav className="km-tabs" aria-label="当前分组">
            {group.items.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`km-tab ${screen === id ? "km-tab-active" : ""}`}
                onClick={() => setScreen(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <section className="km-shell-wide space-y-4 py-6 pb-16">
        {screen === "overview" ? <OverviewPreview onGo={setScreen} /> : null}
        {screen === "orders" ? <OrdersPreview /> : null}
        {screen === "cdks" ? <CdkPreview /> : null}
        {screen === "usage" ? <UsagePreview /> : null}
        {screen === "commerce" ? <CommercePreview onGo={setScreen} /> : null}
        {screen === "finished" ? <FinishedPreview /> : null}
        {screen === "selection" ? <SelectionPreview onGo={setScreen} /> : null}
        {screen === "agents" ? <AgentManagePreview /> : null}
        {screen === "draw" ? <AgentDrawPreview /> : null}
        {screen === "week" ? <WeekScreen /> : null}
        {screen === "earnings" ? <AgentEarningsPreview /> : null}
        {screen === "integration" ? <IntegrationPreview onGo={setScreen} /> : null}
        {screen === "guard" ? <GuardPreview /> : null}
        {screen === "apikeys" ? <ApiKeysPreview /> : null}
        {screen === "announcements" ? <AnnouncementsPreview /> : null}
        {screen === "appearance" ? <AppearancePreview /> : null}
        {screen === "guide" ? <GuidePreview onGo={setScreen} /> : null}
      </section>
    </div>
  );
}

function WeekScreen() {
  const [week, setWeek] = useState("1005");
  const [openAgent, setOpenAgent] = useState("HelloAI");
  const [paid, setPaid] = useState<Record<string, boolean>>(
    Object.fromEntries(PAYOUTS.map((row) => [row.agent, row.paid])),
  );
  const locked = week === "now";
  const historic = week === "0928";

  return (
    <>
      <div>
        <p className="text-xs text-[var(--km-fg-muted)]">周结已停用，请到「对账」按代理结清。</p>
        <h1 className="mt-1 text-2xl font-semibold">历史周结</h1>
      </div>
      <div className="flex flex-wrap gap-2">
        {WEEKS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`rounded-2xl border px-3 py-2 text-left ${week === item.id ? "border-[var(--km-fg)]" : "border-[var(--km-border)]"}`}
            onClick={() => setWeek(item.id)}
          >
            <b className="block text-sm">{item.label}</b>
            <span className="text-xs text-[var(--km-fg-muted)]">{item.state}</span>
          </button>
        ))}
      </div>
      <p className="text-sm text-[var(--km-fg-muted)]">
        一周是周一 00:00 到周日 24:00。收益按订单当时记下的手续费算，之后改费率不会改旧周。
      </p>
      {locked ? (
        <div className="km-panel text-sm">
          这一周还没结束，现在只是累计。HelloAI ¥86.40，huyazhou ¥12.00。周结已停用，不会再自动出打款单，请到「对账」按代理结清。
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="本周应付代理" value={historic ? "¥310.20" : "¥291.50"} />
            <Stat label="已打款" value={historic ? "¥310.20" : "¥16.14"} />
            <Stat label="没自动进去" value={historic ? "0" : "2"} />
          </div>
          <section className="km-panel overflow-x-auto">
            <table className="km-table min-w-[760px] text-sm">
              <thead>
                <tr>
                  <th>代理</th>
                  <th>单数</th>
                  <th>货款</th>
                  <th>手续费</th>
                  <th>代理收益</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {PAYOUTS.map((row) => {
                  const done = historic || paid[row.agent];
                  return (
                    <Fragment key={row.agent}>
                      <tr>
                        <td className="font-medium">{row.agent}</td>
                        <td>{row.orders}</td>
                        <td>{row.goods}</td>
                        <td>{row.fee}</td>
                        <td>{row.earn}</td>
                        <td className="whitespace-nowrap">{done ? "已打款" : "待打款"}</td>
                        <td className="whitespace-nowrap">
                          <button
                            type="button"
                            className="km-btn km-btn-ghost km-btn-sm"
                            onClick={() => setOpenAgent(openAgent === row.agent ? "" : row.agent)}
                          >
                            {openAgent === row.agent ? "收起" : "明细"}
                          </button>
                          {historic ? null : (
                            <button
                              type="button"
                              className="km-btn km-btn-ghost km-btn-sm ml-2"
                              onClick={() => setPaid((current) => ({ ...current, [row.agent]: !current[row.agent] }))}
                            >
                              {done ? "改回待打款" : "标记已打款"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {openAgent === row.agent ? (
                        <tr>
                          <td colSpan={7} className="bg-[var(--km-bg-muted)]">
                            <table className="w-full text-left text-xs">
                              <thead>
                                <tr className="text-[var(--km-fg-muted)]">
                                  <th className="py-1 pr-3">订单</th>
                                  <th className="py-1 pr-3">套餐</th>
                                  <th className="py-1 pr-3">货款</th>
                                  <th className="py-1">代理收益</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr className="border-t border-[var(--km-border)]">
                                  <td className="py-2 pr-3 font-mono">KS…F2GLCL</td>
                                  <td className="py-2 pr-3">ChatGPT Pro 20x</td>
                                  <td className="py-2 pr-3">¥175.00</td>
                                  <td className="py-2">¥12.40</td>
                                </tr>
                                <tr className="border-t border-[var(--km-border)]">
                                  <td className="py-2 pr-3 font-mono">KS…VHNDU7</td>
                                  <td className="py-2 pr-3">Plus</td>
                                  <td className="py-2 pr-3">¥115.00</td>
                                  <td className="py-2">¥8.10</td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>
          {historic ? null : (
            <section className="km-panel space-y-2 text-sm">
              <h2 className="font-semibold">这周没自动进去的 2 笔</h2>
              <p className="text-[var(--km-fg-muted)]">处理完进下一周。已经生成的单不重算。</p>
              <p>KS…Q3C · gpt代充站 · 收益还被旧结算单占着</p>
              <p>KS…HMTQ · huyazhou · 下单时没记上手续费</p>
            </section>
          )}
        </>
      )}
    </>
  );
}


function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="km-stat">
      <p className="text-xs text-[var(--km-fg-muted)]">{label}</p>
      <p className="km-stat-value text-2xl">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--km-fg-muted)]">{hint}</p> : null}
    </div>
  );
}
