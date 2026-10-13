"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KmSelect } from "@/components/km-select";

type Go = (screen: "overview" | "orders" | "cdks" | "usage" | "commerce" | "finished" | "selection" | "agents" | "draw" | "week" | "earnings" | "integration" | "guard" | "apikeys" | "announcements" | "appearance" | "guide") => void;

function Note({ text, onClose }: { text: string; onClose: () => void }) {
  if (!text) return null;
  return (
    <div className="km-panel flex items-center justify-between gap-3 text-sm">
      <span>{text}</span>
      <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={onClose}>知道了</button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>
        {label}
        {hint ? <span className="ml-2 text-xs text-[var(--km-fg-muted)]">{hint}</span> : null}
      </span>
      {children}
    </label>
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

function MenuButton({ label, items }: { label: string; items: Array<{ label: string; danger?: boolean; run: () => void }> }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const up = window.innerHeight - rect.bottom < 180;
    setBox({ top: up ? rect.top - 6 : rect.bottom + 6, left: Math.max(8, rect.right - 168), up });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);
  return (
    <>
      <button ref={buttonRef} type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setOpen((value) => !value)}>
        {label}
      </button>
      {open && box
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-40 w-40 rounded-xl border border-[var(--km-border)] bg-[var(--km-bg-elevated)] py-1 shadow-lg"
              style={{ top: box.top, left: box.left, transform: box.up ? "translateY(-100%)" : undefined }}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-[var(--km-bg-muted)] ${item.danger ? "text-red-600" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    item.run();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function OverviewPreview({ onGo }: { onGo: Go }) {
  const [note, setNote] = useState("");
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <div className="km-panel border-[var(--km-danger)]/40 text-sm">
        <p>有 2 张卡密占用中。若订单已失败仍锁着，点下面修复。</p>
        <p className="mt-1">有 1 笔开通未结束。服务端每分钟会轮询卡台，也可以立刻重拉。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="km-btn km-btn-ghost text-sm" onClick={() => setNote("已修复锁：释放 2，核销 0")}>修复卡住的锁</button>
          <button type="button" className="km-btn km-btn-ghost text-sm" onClick={() => setNote("已向卡台重拉 1 笔进行中订单")}>立即轮询进行中订单</button>
          <button type="button" className="km-btn km-btn-ghost text-sm" onClick={() => onGo("guide")}>使用说明</button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="可用卡密" value="128" />
        <Stat label="订单总数" value="1,204" />
        <Stat label="已核销" value="860" />
        <Stat label="卡台接入" value="已配置" hint="余额 1879.69 USD" />
      </div>
      <div className="km-panel grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
        {[
          ["未用", "128"],
          ["占用", "2"],
          ["已售", "40"],
          ["已核销", "860"],
          ["停用", "6"],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-xs text-[var(--km-fg-muted)]">{label}</div>
            <div className="km-stat-value mt-1 !text-2xl">{value}</div>
          </div>
        ))}
      </div>
      <div className="km-panel">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">最近订单</h2>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => onGo("orders")}>全部订单</button>
        </div>
        <table className="km-table text-sm">
          <thead>
            <tr><th>订单</th><th>类型</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="font-mono text-xs">KS202610042108R61T</td>
              <td>商城</td>
              <td><span className="km-badge km-badge-ok">已发卡</span></td>
            </tr>
            <tr>
              <td className="font-mono text-xs">RC202610042012GR2B</td>
              <td>兑换</td>
              <td><span className="km-badge km-badge-wait">开通中</span></td>
            </tr>
            <tr>
              <td className="font-mono text-xs">KS2026100418339Q3C</td>
              <td>商城</td>
              <td><span className="km-badge km-badge-bad">失败</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ShopOrder = {
  no: string;
  store: string;
  agent: string;
  kind: string;
  email: string;
  code: string;
  plan: string;
  pay: string;
  fulfill: string;
  at: string;
  hidden: boolean;
};

const ORDERS: ShopOrder[] = [
  { no: "RC202610042108", store: "KS…8R61T", agent: "HelloAI", kind: "兑换", email: "a@edu.cn", code: "****8R61", plan: "Pro 20x", pay: "商城已付", fulfill: "成功", at: "10-04 21:08", hidden: false },
  { no: "RC202610041912", store: "KS…GR2BQ", agent: "HelloAI", kind: "兑换", email: "b@edu.cn", code: "****2BQ1", plan: "Pro 20x", pay: "商城已付", fulfill: "开通中", at: "10-04 19:12", hidden: false },
  { no: "KS202610041100", store: "", agent: "huyazhou", kind: "商城", email: "—", code: "—", plan: "Plus", pay: "未支付", fulfill: "待支付", at: "10-04 11:00", hidden: false },
  { no: "RC202609301100", store: "KS…OLD1", agent: "Polus", kind: "兑换", email: "old@x.com", code: "****OLD1", plan: "Plus", pay: "商城已付", fulfill: "失败", at: "09-30 11:00", hidden: true },
];

export function OrdersPreview() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [hidden, setHidden] = useState(false);
  const [applied, setApplied] = useState({ q: "", status: "", hidden: false });
  const [open, setOpen] = useState("RC202610042108");
  const [note, setNote] = useState("");
  const rows = useMemo(
    () =>
      ORDERS.filter((order) => {
        if (!applied.hidden && order.hidden) return false;
        if (applied.status && order.fulfill !== applied.status && order.pay !== applied.status) return false;
        const query = applied.q.trim().toLowerCase();
        if (!query) return true;
        return [order.no, order.store, order.agent, order.email, order.code, order.plan].join(" ").toLowerCase().includes(query);
      }),
    [applied],
  );
  return (
    <div className="space-y-3">
      <Note text={note} onClose={() => setNote("")} />
      <div className="km-panel overflow-x-auto text-sm">
        <div className="km-toolbar">
          <input className="km-input max-w-xs" placeholder="订单号 / 邮箱 / 卡密后四位" value={q} onChange={(event) => setQ(event.target.value)} />
          <KmSelect
            className="w-36"
            value={status}
            placeholder="全部状态"
            options={[
              { value: "", label: "全部状态" },
              { value: "成功", label: "成功" },
              { value: "开通中", label: "开通中" },
              { value: "失败", label: "失败" },
              { value: "未支付", label: "未支付" },
            ]}
            onChange={setStatus}
          />
          <label className="flex items-center gap-2 text-sm text-[var(--km-fg-muted)]">
            <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
            显示已隐藏
          </label>
          <button type="button" className="km-btn" onClick={() => setApplied({ q, status, hidden })}>筛选</button>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("已向卡台重拉进行中的兑换单")}>轮询进行中</button>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("已修复锁：释放 2，核销 0")}>修复卡住的锁</button>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("导出会按当前筛选出 CSV")}>导出 CSV</button>
        </div>
        <table className="km-table min-w-[980px]">
          <thead>
            <tr>
              <th>订单</th><th>类型</th><th>邮箱</th><th>卡密</th><th>套餐</th><th>支付</th><th>履约</th><th>时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((order) => (
              <Fragment key={order.no}>
                <tr>
                  <td className="font-mono text-xs">
                    {order.no}
                    {order.store ? <div className="text-[var(--km-fg-muted)]">{order.store} · {order.agent}</div> : null}
                  </td>
                  <td>{order.kind}</td>
                  <td>{order.email}</td>
                  <td className="font-mono">{order.code}</td>
                  <td>{order.plan}</td>
                  <td>{order.pay}</td>
                  <td>{order.fulfill}</td>
                  <td className="text-[var(--km-fg-muted)]">{order.at}</td>
                  <td>
                    {order.kind === "兑换" ? (
                      <div className="flex gap-1">
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNote(`已重拉 ${order.no}`)}>重拉</button>
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setOpen(open === order.no ? "" : order.no)}>
                          {open === order.no ? "收起" : "明细"}
                        </button>
                      </div>
                    ) : (
                      <span className="text-[var(--km-fg-muted)]">—</span>
                    )}
                  </td>
                </tr>
                {open === order.no ? (
                  <tr>
                    <td colSpan={9} className="bg-[var(--km-bg-muted)] px-3 py-3 text-xs">
                      <p>21:08 创建兑换单</p>
                      <p>21:08 卡台受理，请求号 UP…881</p>
                      <p>21:09 {order.fulfill === "成功" ? "开通成功，账号 a@edu.cn" : order.fulfill}</p>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="py-4 text-[var(--km-fg-muted)]">无匹配订单</p> : null}
      </div>
    </div>
  );
}

type CdkRow = { id: number; masked: string; full: string; status: string; plan: string; order: string; agent: string; at: string };

const CDKS: CdkRow[] = [
  { id: 1, masked: "KM-****-8R61", full: "KM-91F2-8R61-QQ10", status: "未使用", plan: "pro_20x", order: "KS…8R61T", agent: "HelloAI", at: "10-04 21:08" },
  { id: 2, masked: "KM-****-2210", full: "KM-22AA-2210-CL09", status: "已核销", plan: "plus", order: "KS…VHNDU", agent: "huyazhou", at: "10-03 18:11" },
  { id: 3, masked: "KM-****-0194", full: "KM-0194-XX11-0002", status: "已禁用", plan: "credit250", order: "KS…0194", agent: "Polus", at: "10-02 09:40" },
];

export function CdkPreview() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [applied, setApplied] = useState({ q: "", status: "" });
  const [rows, setRows] = useState(CDKS);
  const [shown, setShown] = useState<number[]>([]);
  const [copied, setCopied] = useState(0);
  const [note, setNote] = useState("");
  const visible = rows.filter((row) => {
    if (applied.status && row.status !== applied.status) return false;
    const query = applied.q.trim().toLowerCase();
    if (!query) return true;
    return [row.masked, row.full, row.plan, row.order, row.agent].join(" ").toLowerCase().includes(query);
  });
  return (
    <div className="space-y-3">
      <Note text={note} onClose={() => setNote("")} />
      <div className="km-panel overflow-x-auto text-sm">
        <div className="km-toolbar">
          <input className="km-input max-w-xs font-mono" placeholder="订单号 / 完整卡密 / 套餐" value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setApplied({ q, status }); }} />
          <KmSelect className="w-36" value={status} placeholder="全部状态" options={[{ value: "", label: "全部状态" }, { value: "未使用", label: "未使用" }, { value: "已核销", label: "已核销" }, { value: "已禁用", label: "已禁用" }]} onChange={setStatus} />
          <button type="button" className="km-btn" onClick={() => setApplied({ q, status })}>筛选</button>
          <span className="ml-auto text-xs text-[var(--km-fg-muted)]">共 {visible.length} 条店铺已售卡密 · 默认脱敏，点「显示」后再复制</span>
        </div>
        <table className="km-table min-w-[860px]">
          <thead>
            <tr><th>卡密</th><th>状态</th><th>套餐</th><th>订单</th><th>代理</th><th>更新</th><th>操作</th></tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const open = shown.includes(row.id);
              return (
                <tr key={row.id}>
                  <td>
                    <code className="font-mono">{open ? row.full : row.masked}</code>
                    {open ? (
                      <button type="button" className="ml-2 text-xs text-[var(--km-fg-muted)]" onClick={() => setCopied(row.id)}>{copied === row.id ? "已复制" : "复制"}</button>
                    ) : (
                      <button type="button" className="ml-2 text-xs text-[var(--km-fg-muted)]" onClick={() => setShown((current) => [...current, row.id])}>显示</button>
                    )}
                  </td>
                  <td>{row.status}</td>
                  <td className="font-mono text-xs">{row.plan}</td>
                  <td className="font-mono text-xs">{row.order}</td>
                  <td>{row.agent}</td>
                  <td className="text-[var(--km-fg-muted)]">{row.at}</td>
                  <td className="whitespace-nowrap">
                    {row.status === "未使用" ? (
                      <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => { setRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "已核销" } : item)); setNote("已核销"); }}>核销</button>
                    ) : null}
                    {row.status === "未使用" ? (
                      <button type="button" className="km-btn km-btn-ghost km-btn-sm text-red-600" onClick={() => { setRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "已禁用" } : item)); setNote("已禁用"); }}>禁用</button>
                    ) : null}
                    {row.status === "已禁用" ? (
                      <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "未使用" } : item))}>启用</button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UsagePreview() {
  const [preset, setPreset] = useState("week");
  const [agent, setAgent] = useState("");
  const [coupons, setCoupons] = useState([
    { code: "HELLO10", agent: "HelloAI", off: "¥10", used: "6 / 20", enabled: true },
    { code: "PLUS5", agent: "huyazhou", off: "95 折", used: "1 / 不限", enabled: false },
  ]);
  return (
    <div className="space-y-6">
      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold">用量统计</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">看下单、发卡和未兑换积压。钱在「收益统计」。优惠券只能停用，不能改代理设的金额。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {[["today", "今天"], ["week", "本周"], ["month", "本月"], ["custom", "自定义"]].map(([id, label]) => (
            <button key={id} type="button" className={`km-tab ${preset === id ? "km-tab-active" : ""}`} onClick={() => setPreset(id)}>{label}</button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {preset === "custom" ? (
            <>
              <input className="km-input" type="date" defaultValue="2026-09-01" />
              <input className="km-input" type="date" defaultValue="2026-10-04" />
            </>
          ) : (
            <p className="self-center text-sm text-[var(--km-fg-muted)] md:col-span-2">2026-09-29 至 2026-10-05</p>
          )}
          <KmSelect value={agent} placeholder="全部代理" options={[{ value: "", label: "全部代理" }, { value: "1", label: "HelloAI" }, { value: "2", label: "huyazhou" }]} onChange={setAgent} />
        </div>
      </section>
      <section className="km-panel space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="下单" value="86" />
          <Stat label="已支付" value="71" />
          <Stat label="未支付" value="12" />
          <Stat label="已退款" value="3" />
          <Stat label="已发齐" value="64" />
          <Stat label="部分发货" value="2" />
          <Stat label="已付未发" value="5" />
          <Stat label="已售账号" value="9" />
        </div>
        <div>
          <h3 className="text-sm font-medium">卡密</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="区间已发" value="70" />
            <Stat label="区间未兑换" value="18" />
            <Stat label="区间已兑换" value="49" />
            <Stat label="兑换中 / 占用" value="2" />
            <Stat label="当前未兑换积压" value="36" />
          </div>
        </div>
        {agent ? null : (
          <div className="overflow-x-auto">
            <h3 className="text-sm font-medium">按代理</h3>
            <table className="mt-2 w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--km-border)]"><th className="py-2 pr-3">代理</th><th className="py-2 pr-3">下单</th><th className="py-2 pr-3">已付</th><th className="py-2">未兑换积压</th></tr>
              </thead>
              <tbody>
                <tr className="border-b border-[var(--km-border)]"><td className="py-2 pr-3">HelloAI</td><td className="py-2 pr-3">41</td><td className="py-2 pr-3">36</td><td className="py-2">12</td></tr>
                <tr><td className="py-2 pr-3">huyazhou</td><td className="py-2 pr-3">14</td><td className="py-2 pr-3">11</td><td className="py-2">4</td></tr>
              </tbody>
            </table>
          </div>
        )}
        <div>
          <h3 className="text-sm font-medium">优惠券</h3>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]"><th className="py-2 pr-3">券码</th><th className="py-2 pr-3">代理</th><th className="py-2 pr-3">优惠</th><th className="py-2 pr-3">已用</th><th className="py-2">操作</th></tr>
            </thead>
            <tbody>
              {coupons.map((coupon) => (
                <tr key={coupon.code} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3 font-mono">{coupon.code}</td>
                  <td className="py-2 pr-3">{coupon.agent}</td>
                  <td className="py-2 pr-3">{coupon.off}</td>
                  <td className="py-2 pr-3">{coupon.used}</td>
                  <td className="py-2">
                    <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setCoupons((current) => current.map((item) => item.code === coupon.code ? { ...item, enabled: !item.enabled } : item))}>
                      {coupon.enabled ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

type IssueOrder = { no: string; agent: string; plan: string; amount: string; pay: string; fulfill: string; fee: string; invoice: string };

const ISSUE_ORDERS: IssueOrder[] = [
  { no: "KS…8R61T", agent: "HelloAI · Pro 20x", plan: "开票", amount: "¥175.00", pay: "已支付", fulfill: "已发卡", fee: "按费率估算", invoice: "华东师范大学 · 783198398@qq.com" },
  { no: "KS…GR2BQ", agent: "HelloAI · Pro 20x", plan: "", amount: "¥175.00", pay: "未支付", fulfill: "等待中", fee: "核对中", invoice: "" },
  { no: "KS…TXD4", agent: "kabuqinoo · Pro 5x", plan: "", amount: "¥2343.00", pay: "未支付", fulfill: "等待中", fee: "核对中", invoice: "备注 N" },
];

export function CommercePreview({ onGo }: { onGo: Go }) {
  const [salesOpen, setSalesOpen] = useState(true);
  const [maxBuy, setMaxBuy] = useState("5");
  const [batch, setBatch] = useState("20");
  const [base, setBase] = useState("https://kaimi.example.com");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [pay, setPay] = useState("");
  const [fulfill, setFulfill] = useState("");
  const [applied, setApplied] = useState({ q: "", pay: "", fulfill: "" });
  const rows = ISSUE_ORDERS.filter((order) => {
    if (applied.pay && order.pay !== applied.pay) return false;
    if (applied.fulfill && order.fulfill !== applied.fulfill) return false;
    const query = applied.q.trim().toLowerCase();
    if (!query) return true;
    return [order.no, order.agent, order.invoice].join(" ").toLowerCase().includes(query);
  });
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="km-btn km-btn-ghost" onClick={() => onGo("agents")}>代理管理</button>
        <button type="button" className="km-btn km-btn-ghost" onClick={() => onGo("week")}>历史周结</button>
        <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("导出会下载全部收益 Excel")}>导出全部收益</button>
      </div>
      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">运营状态</h2>
          <div className="flex gap-2">
            <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("已重新检查卡台和支付")}>刷新检查</button>
            <button type="button" className="km-btn km-btn-ghost" onClick={() => setSalesOpen((value) => !value)}>{salesOpen ? "手动关店" : "恢复开店"}</button>
          </div>
        </div>
        <p className="text-sm">{salesOpen ? "店铺购买开放" : "店铺购买已关闭"}</p>
        <p className="text-sm text-[var(--km-fg-muted)]">卡台余额 1879.69 USD · 易支付已配置 · 失败任务 1</p>
      </section>
      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold">即时发卡订单</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">按下单时间倒序。开票单能搜抬头和收票邮箱。套餐价格在代理管理，商店收益和提卡请到「对账」按代理结清，这里不再生成结算单。</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="关键字"><input className="km-input w-full" placeholder="订单号 / 代理 / 套餐 / 抬头" value={q} onChange={(event) => setQ(event.target.value)} /></Field>
          <Field label="支付"><KmSelect value={pay} options={[{ value: "", label: "全部支付" }, { value: "已支付", label: "已支付" }, { value: "未支付", label: "未支付" }]} onChange={setPay} /></Field>
          <Field label="发卡"><KmSelect value={fulfill} options={[{ value: "", label: "全部发卡" }, { value: "已发卡", label: "已发卡" }, { value: "等待中", label: "等待中" }]} onChange={setFulfill} /></Field>
          <div className="flex items-end gap-2">
            <button type="button" className="km-btn km-btn-sm" onClick={() => setApplied({ q, pay, fulfill })}>筛选</button>
            <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => { setQ(""); setPay(""); setFulfill(""); setApplied({ q: "", pay: "", fulfill: "" }); }}>清空</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">订单</th><th className="py-2 pr-3">代理/套餐</th><th className="py-2 pr-3">金额</th><th className="py-2 pr-3">支付</th><th className="py-2 pr-3">发卡</th><th className="py-2 pr-3">手续费</th><th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr key={order.no} className="border-b border-[var(--km-border)]">
                  <td className="py-3 pr-3 font-mono text-xs">{order.no}</td>
                  <td className="py-3 pr-3">
                    {order.agent}
                    {order.invoice ? <p className="text-xs text-[var(--km-fg-muted)]">{order.plan ? `${order.plan} · ` : ""}{order.invoice}</p> : null}
                  </td>
                  <td className="py-3 pr-3">{order.amount}</td>
                  <td className="py-3 pr-3">{order.pay}</td>
                  <td className="py-3 pr-3">{order.fulfill}</td>
                  <td className="py-3 pr-3">{order.fee}</td>
                  <td className="py-3">
                    <MenuButton
                      label="操作"
                      items={[
                        { label: "复制查单链接", run: () => setNote(`${order.no} 的查单链接已复制`) },
                        { label: "再推开票通知", run: () => setNote("已再推 Telegram 开票通知") },
                        { label: "登记退款", danger: true, run: () => setNote(`${order.no} 已登记退款，静态稿不改卡台`) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">下单规则</h2>
        <Field label="一次最多买几张" hint="默认 5，最多 50。库存不够会先发一部分再补。">
          <input className="km-input w-40" value={maxBuy} onChange={(event) => setMaxBuy(event.target.value)} />
        </Field>
        <Field label="批量兑换一次最多几张" hint="默认 20，最多 50。太大卡台容易限流。">
          <input className="km-input w-40" value={batch} onChange={(event) => setBatch(event.target.value)} />
        </Field>
        <button type="button" className="km-btn" onClick={() => setNote(`下单规则已记下：最多 ${maxBuy} 张，批量 ${batch} 张`)}>保存下单规则</button>
      </section>
      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">易支付商户与手续费</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">异步通知不能填 localhost，否则支付成功也不会发卡。改费率只影响之后的新订单。</p>
        <Field label="本站公网地址"><input className="km-input w-full" value={base} onChange={(event) => setBase(event.target.value)} /></Field>
        <p className="break-all font-mono text-xs text-[var(--km-fg-muted)]">异步通知：{base.replace(/\/+$/, "")}/api/webhooks/epay</p>
        <div className="grid gap-3 md:grid-cols-3">
          <input className="km-input" defaultValue="https://pay.example.com" />
          <input className="km-input" defaultValue="10001" />
          <input className="km-input" type="password" placeholder="商户密钥（留空不修改）" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[
            ["支付宝", "6000", "10"],
            ["微信支付", "6000", "0"],
          ].map(([name, ppm, fixed]) => (
            <div key={name} className="space-y-3 rounded-xl border border-[var(--km-border)] p-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" defaultChecked />{name}</label>
              <Field label="比例费率（PPM）" hint="6000 = 0.6%"><input className="km-input w-full" defaultValue={ppm} /></Field>
              <Field label="每笔固定手续费（分）" hint="10 = 0.10 元"><input className="km-input w-full" defaultValue={fixed} /></Field>
            </div>
          ))}
        </div>
        <button type="button" className="km-btn" onClick={() => setNote("支付配置已记下。旧订单的手续费不重算。")}>保存支付配置</button>
      </section>
      <section className="km-panel space-y-3 text-sm">
        <h2 className="text-xl font-semibold">异常后台任务</h2>
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[var(--km-border)] text-xs text-[var(--km-fg-muted)]"><th className="py-2 pr-3">任务</th><th className="py-2 pr-3">状态</th><th className="py-2 pr-3">尝试</th><th className="py-2 pr-3">错误</th><th className="py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-2 pr-3">补发卡 KS…GR2BQ</td>
              <td className="py-2 pr-3">失败</td>
              <td className="py-2 pr-3">3</td>
              <td className="py-2 pr-3">卡台超时</td>
              <td className="py-2"><button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNote("已重新排队")}>重试</button></td>
            </tr>
          </tbody>
        </table>
      </section>
      <section className="km-panel text-sm">
        <h2 className="text-xl font-semibold">卡台账户</h2>
        <p className="mt-2 text-[var(--km-fg-muted)]">地址和 API Key 在「接入卡台」。这里只看余额和连通。</p>
        <p className="mt-2">可用余额 1879.69 USD · 易支付已配置</p>
        <button type="button" className="km-btn km-btn-ghost mt-3" onClick={() => onGo("integration")}>去接入卡台</button>
      </section>
    </div>
  );
}

export function FinishedPreview() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState([
    { email: "gpt01@example.com", status: "未售", secret: "已加密", order: "—" },
    { email: "gpt02@example.com", status: "已售", secret: "已加密", order: "KS…GPT02" },
    { email: "gpt03@example.com", status: "已作废", secret: "已加密", order: "—" },
  ]);
  const [note, setNote] = useState("");
  const visible = rows.filter((row) => (!status || row.status === status) && (!q.trim() || row.email.includes(q.trim().toLowerCase())));
  const counts = {
    unused: rows.filter((row) => row.status === "未售").length,
    sold: rows.filter((row) => row.status === "已售").length,
    disabled: rows.filter((row) => row.status === "已作废").length,
  };
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <section className="km-panel space-y-3">
        <h2 className="text-xl font-semibold">成品号库存</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">一行一枚：邮箱----GPT密码----邮箱密码----Session。有货显示「有货」，卖完仍上架为「补货中」，不显示具体数量。</p>
        <p className="text-sm">未售 <strong>{counts.unused}</strong> · 已售 {counts.sold} · 已作废 {counts.disabled}</p>
        <textarea className="km-input min-h-36 font-mono text-xs" value={text} onChange={(event) => setText(event.target.value)} placeholder="user@example.com----gptPass----mailPass----session..." />
        <button
          type="button"
          className="km-btn"
          onClick={() => {
            const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
            if (!lines.length) {
              setNote("先贴入至少一行");
              return;
            }
            setRows((current) => [
              ...lines.map((line) => ({ email: line.split("----")[0] || line, status: "未售", secret: "已加密", order: "—" })),
              ...current,
            ]);
            setText("");
            setNote(`入库 ${lines.length} 枚`);
          }}
        >
          入库
        </button>
      </section>
      <section className="km-panel space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <input className="km-input w-56" placeholder="按邮箱搜索" value={q} onChange={(event) => setQ(event.target.value)} />
          <KmSelect className="w-32" value={status} options={[{ value: "", label: "全部状态" }, { value: "未售", label: "未售" }, { value: "已售", label: "已售" }, { value: "已作废", label: "已作废" }]} onChange={setStatus} />
        </div>
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[var(--km-border)]"><th className="py-2 pr-3">邮箱</th><th className="py-2 pr-3">状态</th><th className="py-2 pr-3">密码 / Session</th><th className="py-2 pr-3">订单</th><th className="py-2">操作</th></tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.email} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">{row.email}</td>
                <td className="py-2 pr-3">{row.status}</td>
                <td className="py-2 pr-3">{row.secret}</td>
                <td className="py-2 pr-3 font-mono text-xs">{row.order}</td>
                <td className="py-2">
                  {row.status === "未售" ? (
                    <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setRows((current) => current.map((item) => item.email === row.email ? { ...item, status: "已作废" } : item))}>作废</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function SelectionPreview({ onGo }: { onGo: Go }) {
  const [account, setAccount] = useState("main");
  const [products, setProducts] = useState([
    { code: "gpt-plus", name: "Plus", online: true, rank: 1 },
    { code: "gpt-pro", name: "Pro", online: true, rank: 2 },
    { code: "gpt-go", name: "Go", online: false, rank: 3 },
  ]);
  const [strict, setStrict] = useState(true);
  const [perCard, setPerCard] = useState("1");
  const [region, setRegion] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">选卡配置</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">产品、在线状态和选卡优先级按卡台账户独立保存。主台的产品码不会套到备台。</p>
          </div>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => onGo("integration")}>去接入卡台</button>
        </div>
        <div className="flex gap-2">
          <button type="button" className={`km-btn ${account === "main" ? "" : "km-btn-ghost"}`} onClick={() => setAccount("main")}>主台 · 主</button>
          <button type="button" className={`km-btn ${account === "backup" ? "" : "km-btn-ghost"}`} onClick={() => setAccount("backup")}>备台 · 备</button>
        </div>
      </section>
      <section className="km-panel space-y-3 text-sm">
        <h3 className="font-semibold">产品在线状态 · {account === "main" ? "主台" : "备台"}</h3>
        {products.map((product) => (
          <label key={product.code} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--km-border)] px-3 py-2">
            <span>{product.code} / {product.name}</span>
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={product.online} onChange={(event) => setProducts((current) => current.map((item) => item.code === product.code ? { ...item, online: event.target.checked } : item))} />
              {product.online ? "在线" : "已下线"}
            </span>
          </label>
        ))}
      </section>
      <section className="km-panel space-y-3 text-sm">
        <h3 className="font-semibold">选卡优先级</h3>
        <p className="text-[var(--km-fg-muted)]">顺序越靠前优先级越高。已下线的自动跳过。保存后整份列表同步到该卡台。</p>
        {products.map((product, index) => (
          <div key={product.code} className="flex items-center gap-2">
            <span className="w-6 text-[var(--km-fg-muted)]">{index + 1}</span>
            <span className="flex-1">{product.name}</span>
            <button type="button" className="km-btn km-btn-ghost km-btn-sm" disabled={index === 0} onClick={() => setProducts((current) => {
              const next = [...current];
              const [item] = next.splice(index, 1);
              next.splice(index - 1, 0, item);
              return next;
            })}>上移</button>
          </div>
        ))}
        <button type="button" className="km-btn" onClick={() => setNote("选卡优先级已保存，并会同步到卡台")}>保存选卡优先级</button>
      </section>
      <section className="km-panel space-y-3 text-sm">
        <h3 className="font-semibold">本站可控策略</h3>
        <label className="flex items-center gap-2"><input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />严格按优先级，不自动换卡</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="每卡新账号上限"><input className="km-input w-full" value={perCard} onChange={(event) => setPerCard(event.target.value)} /></Field>
          <Field label="限定发卡地区" hint="空表示不限"><input className="km-input w-full" placeholder="例如 US" value={region} onChange={(event) => setRegion(event.target.value)} /></Field>
        </div>
        <button type="button" className="km-btn" onClick={() => setNote("本站策略已记下。失败冷却和地区只存在本站，卡台不读。")}>保存本站策略</button>
      </section>
    </div>
  );
}

export function IntegrationPreview({ onGo }: { onGo: Go }) {
  const [note, setNote] = useState("");
  const [accounts, setAccounts] = useState([
    { name: "主台", url: "https://card.example", key: "sk_live_••••", primary: true },
  ]);
  const [draft, setDraft] = useState({ name: "备台", url: "", key: "" });
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <section className="km-panel space-y-3">
        <h2 className="text-xl font-semibold">卡台接入</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">多账户、协议和出口 IP 在这里配。选卡优先级在「选卡配置」。本站不发双绑码，每单只从指定账户出一张卡。</p>
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
          <div>
            <p className="text-xs text-[var(--km-fg-muted)]">本机出口 IPv4</p>
            <p className="font-mono text-lg">203.0.113.18</p>
          </div>
          <p className="flex-1 text-[var(--km-fg-muted)]">把这个 IPv4 加到卡台 API Key 白名单，否则连通会 403。</p>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("已复制 203.0.113.18")}>复制 IP</button>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("已重新探测出口 IP")}>重探测</button>
        </div>
      </section>
      <section className="km-panel space-y-3 text-sm">
        <h3 className="font-semibold">多卡台账户</h3>
        {accounts.map((account) => (
          <div key={account.name} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--km-border)] px-3 py-2">
            <span>{account.name}{account.primary ? " · 主" : " · 备"} · {account.url || "未填地址"}</span>
            <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNote(`${account.name} 连通正常，余额 1879.69 USD`)}>测试</button>
          </div>
        ))}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="名称"><input className="km-input w-full" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
          <Field label="卡台地址"><input className="km-input w-full" value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} /></Field>
          <Field label="OpenAPI Key"><input className="km-input w-full" type="password" value={draft.key} onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))} /></Field>
        </div>
        <button
          type="button"
          className="km-btn"
          onClick={() => {
            if (!draft.url.trim() || !draft.key.trim()) {
              setNote("地址和 Key 都要填");
              return;
            }
            setAccounts((current) => [...current, { name: draft.name || "备台", url: draft.url, key: "已保存", primary: false }]);
            setNote("账户已添加。静态稿不会真的连卡台。");
          }}
        >
          添加账户
        </button>
        <button type="button" className="km-btn km-btn-ghost" onClick={() => onGo("selection")}>去选卡配置</button>
      </section>
      <section className="km-panel space-y-3 text-sm">
        <h2 className="text-xl font-semibold">站点通知</h2>
        <p className="text-[var(--km-fg-muted)]">兑换到终态时可选推 Webhook 或 Telegram。内容含代理、账号、套餐、售价和本次收益。和卡台接入无关。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="本站公网地址" hint="不能填 localhost"><input className="km-input w-full" defaultValue="https://kaimi.example.com" /></Field>
          <Field label="终态通知地址"><input className="km-input w-full" placeholder="https://example.com/notify" /></Field>
          <Field label="Telegram Token"><input className="km-input w-full font-mono" type="password" placeholder="留空则不修改" /></Field>
          <Field label="Telegram Chat ID" hint="用 chat.id，不要填 update_id"><input className="km-input w-full" defaultValue="123456789" /></Field>
        </div>
        <div className="flex gap-2">
          <button type="button" className="km-btn" onClick={() => setNote("通知设置已记下")}>保存通知设置</button>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => setNote("已发测试：测试代理店 / demo@example.com / Plus / ¥150")}>发送测试通知</button>
        </div>
      </section>
    </div>
  );
}

export function GuardPreview() {
  const [blocks, setBlocks] = useState([
    { id: 1, who: "203.0.113.8", reason: "10 分钟内失败 8 次", until: "10-04 22:40" },
    { id: 2, who: "KM-****-2210", reason: "同一张卡重复兑换", until: "10-04 23:10" },
  ]);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <section className="km-panel">
        <h2 className="mb-3 text-xl font-semibold">当前封锁</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]"><th className="py-2 pr-3">对象</th><th className="py-2 pr-3">原因</th><th className="py-2 pr-3">解封时间</th><th className="py-2" /></tr>
          </thead>
          <tbody>
            {blocks.map((block) => (
              <tr key={block.id} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3 font-mono text-xs">{block.who}</td>
                <td className="py-2 pr-3">{block.reason}</td>
                <td className="py-2 pr-3">{block.until}</td>
                <td className="py-2">
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => { setBlocks((current) => current.filter((item) => item.id !== block.id)); setNote(`${block.who} 已提前解封`); }}>解封</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!blocks.length ? <p className="py-3 text-sm text-[var(--km-fg-muted)]">没有封锁</p> : null}
      </section>
      <section className="km-panel">
        <h2 className="mb-3 text-xl font-semibold">近 24 小时失败</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]"><th className="py-2 pr-3">对象</th><th className="py-2">次数</th></tr>
          </thead>
          <tbody>
            <tr><td className="py-2 pr-3 font-mono text-xs">203.0.113.8</td><td className="py-2">8</td></tr>
            <tr><td className="py-2 pr-3 font-mono text-xs">198.51.100.4</td><td className="py-2">3</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

const SCOPES = ["plans:read", "orders:read", "orders:write", "cdks:read", "cdks:reveal", "redeem:write", "redeem:read", "earnings:read", "agents:read"];

export function ApiKeysPreview() {
  const [name, setName] = useState("平台 Key");
  const [picked, setPicked] = useState(["plans:read", "orders:read"]);
  const [token, setToken] = useState("");
  const [rows, setRows] = useState([
    { id: 1, name: "HelloAI 对接", owner: "代理 hncboy", prefix: "km_live_8f21", status: "启用", used: "10-04 18:02" },
    { id: 2, name: "平台对账", owner: "平台", prefix: "km_live_11aa", status: "停用", used: "09-28 09:11" },
  ]);
  return (
    <div className="space-y-4">
      {token ? (
        <div className="km-panel space-y-2 text-sm">
          <p className="font-medium">新 Key 只显示这一次</p>
          <code className="block break-all font-mono text-xs">{token}</code>
        </div>
      ) : null}
      <section className="km-panel space-y-3">
        <h2 className="text-xl font-semibold">新建平台 Key</h2>
        <Field label="名称"><input className="km-input w-full max-w-sm" value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <div className="flex flex-wrap gap-3 text-sm">
          {SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1">
              <input type="checkbox" checked={picked.includes(scope)} onChange={() => setPicked((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope])} />
              {scope}
            </label>
          ))}
        </div>
        <button
          type="button"
          className="km-btn"
          onClick={() => {
            const id = rows.length + 3;
            setRows((current) => [{ id, name: name || "平台 Key", owner: "平台", prefix: `km_live_${id}ab`, status: "启用", used: "从未" }, ...current]);
            setToken(`km_live_${id}ab.${"x".repeat(24)}`);
          }}
        >
          创建
        </button>
      </section>
      <section className="km-panel">
        <h2 className="mb-3 text-xl font-semibold">全部 Key</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]"><th className="py-2 pr-3">名称</th><th className="py-2 pr-3">归属</th><th className="py-2 pr-3">前缀</th><th className="py-2 pr-3">状态</th><th className="py-2 pr-3">最近使用</th><th className="py-2" /></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">{row.name}</td>
                <td className="py-2 pr-3">{row.owner}</td>
                <td className="py-2 pr-3 font-mono text-xs">{row.prefix}</td>
                <td className="py-2 pr-3">{row.status}</td>
                <td className="py-2 pr-3">{row.used}</td>
                <td className="py-2">
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setRows((current) => current.map((item) => item.id === row.id ? { ...item, status: item.status === "启用" ? "停用" : "启用" } : item))}>
                    {row.status === "启用" ? "停用" : "启用"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

type Notice = { id: number; title: string; body: string; at: string; reads: number; live: boolean };

export function AnnouncementsPreview() {
  const [rows, setRows] = useState<Notice[]>([
    { id: 1, title: "本周补货说明", body: "Plus 菲区今晚补货，智利区照常。", at: "10-04 12:00", reads: 4, live: true },
    { id: 2, title: "国庆值班", body: "白天人工看单，夜里自动发卡。", at: "10-01 09:00", reads: 6, live: false },
  ]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(0);
  const [note, setNote] = useState("");
  const current = rows.find((row) => row.live);
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <section className="km-panel">
        <h2 className="text-xl font-semibold">公告</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">写给代理看的。顾客店里和兑换页都不会出现。改已发出的字不会再弹一次；要所有人再看一遍，就新写一条发布。</p>
      </section>
      {current ? (
        <section className="km-panel space-y-2">
          <p className="text-xs text-[var(--km-fg-muted)]">现在生效</p>
          <h3 className="text-lg font-semibold">{current.title}</h3>
          <p className="text-sm">{current.body}</p>
          <p className="text-sm text-[var(--km-fg-muted)]">发布于 {current.at} · 已读 {current.reads} / 6</p>
          <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => { setEditing(current.id); setTitle(current.title); setBody(current.body); }}>改现在这条</button>
        </section>
      ) : null}
      <section className="km-panel space-y-3">
        <h3 className="font-semibold">{editing ? "改现在这条" : "写一条"}</h3>
        <Field label="标题"><input className="km-input w-full" value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label="正文"><textarea className="km-input min-h-28 w-full" value={body} onChange={(event) => setBody(event.target.value)} /></Field>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="km-btn"
            onClick={() => {
              if (!title.trim() || !body.trim()) {
                setNote("标题和正文都要填");
                return;
              }
              if (editing) {
                setRows((list) => list.map((row) => row.id === editing ? { ...row, title, body } : row));
                setNote("已改文字。已读过的代理不会再弹一次。");
              } else {
                setRows((list) => [{ id: Date.now(), title, body, at: "刚刚", reads: 0, live: true }, ...list.map((row) => ({ ...row, live: false }))]);
                setNote("已发布。所有代理下次进后台会看到。");
              }
              setTitle("");
              setBody("");
              setEditing(0);
            }}
          >
            {editing ? "保存修改" : "发布"}
          </button>
          {editing ? (
            <button type="button" className="km-btn km-btn-ghost" onClick={() => { setEditing(0); setTitle(""); setBody(""); }}>取消</button>
          ) : null}
        </div>
      </section>
      <section className="km-panel">
        <h3 className="mb-3 font-semibold">历史</h3>
        {rows.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--km-border)] py-3 text-sm">
            <div>
              <b>{row.title}</b>
              <span className="ml-2 text-[var(--km-fg-muted)]">{row.live ? "生效中" : "已换下"} · {row.at}</span>
            </div>
            {!row.live ? (
              <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setRows((list) => list.map((item) => ({ ...item, live: item.id === row.id })))}>重新发布</button>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}

export function AppearancePreview() {
  const [name, setName] = useState("Kaimi");
  const [theme, setTheme] = useState("paper");
  const [debug, setDebug] = useState(false);
  const [pages, setPages] = useState([
    { id: "home", name: "首页", theme: "paper", announcement: "今晚 Plus 补货", after: "卡密问题走查单页", enabled: true },
    { id: "recharge", name: "兑换页", theme: "paper", announcement: "", after: "兑换失败先看卡密是否已用", enabled: true },
  ]);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-4">
      <Note text={note} onClose={() => setNote("")} />
      <section className="km-panel space-y-3">
        <h3 className="font-semibold">整站外观</h3>
        <p className="text-sm text-[var(--km-fg-muted)]">站点名和主题会应用到全部前台。代理店铺可以各自选主题，不受这里影响。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="站点名"><input className="km-input w-full" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="主题">
            <KmSelect value={theme} options={[{ value: "paper", label: "纸色 / 默认" }, { value: "ink", label: "墨色 / 深" }, { value: "sand", label: "沙色 / 暖" }]} onChange={setTheme} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={debug} onChange={(event) => setDebug(event.target.checked)} />开启内部发卡页（仅调试）</label>
          <button type="button" className="km-btn" onClick={() => setNote(`${name} / ${theme} 已记下${debug ? "，内部发卡页开启" : ""}`)}>保存整站设置</button>
        </div>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        {pages.map((page) => (
          <section key={page.id} className="km-panel space-y-3 text-sm">
            <h3 className="font-semibold">{page.name}</h3>
            <Field label="页面名"><input className="km-input w-full" value={page.name} onChange={(event) => setPages((current) => current.map((item) => item.id === page.id ? { ...item, name: event.target.value } : item))} /></Field>
            <Field label="公告"><textarea className="km-input min-h-20 w-full" value={page.announcement} onChange={(event) => setPages((current) => current.map((item) => item.id === page.id ? { ...item, announcement: event.target.value } : item))} /></Field>
            <Field label="售后说明"><textarea className="km-input min-h-20 w-full" value={page.after} onChange={(event) => setPages((current) => current.map((item) => item.id === page.id ? { ...item, after: event.target.value } : item))} /></Field>
            <label className="flex items-center gap-2"><input type="checkbox" checked={page.enabled} onChange={(event) => setPages((current) => current.map((item) => item.id === page.id ? { ...item, enabled: event.target.checked } : item))} />显示</label>
            <button type="button" className="km-btn" onClick={() => setNote(`${page.name} 的文案已记下`)}>保存页面文案</button>
          </section>
        ))}
      </div>
    </div>
  );
}

export function GuidePreview({ onGo }: { onGo: Go }) {
  const jumps: Array<[Parameters<Go>[0], string, string]> = [
    ["overview", "总览", "看占用卡密、失败订单和今天要处理的数"],
    ["orders", "订单", "兑换和商城单，能重拉卡台、看时间线"],
    ["cdks", "卡密", "已售卡密默认打码，点显示后再复制"],
    ["commerce", "即时发卡", "规则、支付、开票订单。价格不在这里"],
    ["agents", "代理管理", "开户、可售套餐、默认成本价"],
    ["week", "历史周结", "周结已停用，旧待返佣单在这里逐张核验；新的结算到「对账」"],
    ["draw", "提卡账本", "代理自己提卡的未结、结算和申请"],
    ["integration", "接入卡台", "账户、白名单 IP、Telegram"],
  ];
  return (
    <div className="space-y-4">
      <section className="km-panel space-y-2">
        <h2 className="text-lg font-semibold">怎么跑起来</h2>
        <p className="text-sm">先接卡台，再定默认成本，然后给代理开户并勾选套餐。买家在代理店铺付款，系统向卡台要卡，代理按当时费率拿收益。</p>
      </section>
      <section className="km-panel space-y-2">
        <h2 className="text-lg font-semibold">第一次开店</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>接入卡台，把出口 IPv4 加进白名单。</li>
          <li>在代理管理里给出默认成本和零售上限。</li>
          <li>配易支付公网地址，确认异步通知不是 localhost。</li>
          <li>新建代理，把开户说明发给对方。</li>
        </ol>
      </section>
      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">日常怎么管</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {jumps.map(([id, title, text]) => (
            <button key={id} type="button" className="rounded-2xl border border-[var(--km-border)] px-4 py-3 text-left" onClick={() => onGo(id)}>
              <b>{title}</b>
              <p className="mt-1 text-sm text-[var(--km-fg-muted)]">{text}</p>
            </button>
          ))}
        </div>
      </section>
      <section className="km-panel space-y-2 text-sm">
        <h2 className="text-lg font-semibold">状态对照</h2>
        <p>支付：未支付、已支付、已退款。发卡：等待中、已发卡、部分发货。兑换：开通中、成功、失败。提卡：未结、已结算、已作废、手动核销。</p>
        <p>手动核销会退卡台，金额仍算代理未结。作废不再算欠款。</p>
      </section>
    </div>
  );
}
