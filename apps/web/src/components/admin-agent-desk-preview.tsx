"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KmSelect } from "@/components/km-select";
import { PlanPricesPreview } from "@/components/plan-prices-preview";
import { RegionBadge } from "@/components/region-badge";

type AgentStatus = "active" | "disabled";

type AgentRow = {
  id: number;
  name: string;
  username: string;
  slug: string;
  realName: string;
  status: AgentStatus;
  plans: string[];
};

const PLAN_OPTIONS = [
  { key: "plus-ph", name: "Plus · 菲区", cost: "660.00", cap: "1000.00" },
  { key: "plus-cl", name: "Plus · 智利区", cost: "640.00", cap: "10000.00" },
  { key: "pro5-ph", name: "Pro 5x · 菲区", cost: "1020.00", cap: "2000.00" },
  { key: "pro-ph", name: "Pro · 菲区", cost: "1680.00", cap: "2500.00" },
  { key: "pro20", name: "Pro 20x 续费", cost: "1030.00", cap: "2000.00" },
  { key: "gpt", name: "GPT 成品号", cost: "3.00", cap: "" },
];

const SEED: AgentRow[] = [
  { id: 1, name: "HelloAI", username: "hncboy", slug: "helloai", realName: "陈航", status: "active", plans: ["plus-ph", "pro5-ph", "pro-ph", "gpt"] },
  { id: 2, name: "huyazhou", username: "huyazhou", slug: "huyazhou", realName: "", status: "active", plans: ["plus-ph", "plus-cl"] },
  { id: 3, name: "Polus", username: "xxyu", slug: "polus", realName: "徐宇", status: "active", plans: ["pro5-ph"] },
  { id: 4, name: "小浣熊的店", username: "why", slug: "xiaohuanxiong", realName: "", status: "active", plans: ["plus-ph", "gpt"] },
  { id: 5, name: "gpt代充站", username: "onlywjt", slug: "gpt-topup", realName: "", status: "disabled", plans: ["pro20"] },
  { id: 6, name: "kabuqinoo", username: "kabu", slug: "kabu", realName: "", status: "active", plans: [] },
];

const PAGE_SIZE = 20;

function planName(key: string) {
  return PLAN_OPTIONS.find((plan) => plan.key === key)?.name || key;
}

export function AgentManagePreview() {
  const [agents, setAgents] = useState(SEED);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState("");
  const [applied, setApplied] = useState({ query: "", status: "", plan: "" });
  const [page, setPage] = useState(1);
  const [costsOpen, setCostsOpen] = useState(true);
  const [redeemUrl, setRedeemUrl] = useState("/recharge");
  const [notice, setNotice] = useState("");
  const [menuId, setMenuId] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [planAgentId, setPlanAgentId] = useState(0);
  const [nameAgentId, setNameAgentId] = useState(0);
  const [passwordAgentId, setPasswordAgentId] = useState(0);

  const filtered = useMemo(() => {
    const q = applied.query.trim().toLowerCase();
    return agents.filter((agent) => {
      if (applied.status && agent.status !== applied.status) return false;
      if (applied.plan && !agent.plans.includes(applied.plan)) return false;
      if (!q) return true;
      return [agent.name, agent.username, agent.slug, agent.realName].join(" ").toLowerCase().includes(q);
    });
  }, [agents, applied]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const planAgent = agents.find((agent) => agent.id === planAgentId);
  const nameAgent = agents.find((agent) => agent.id === nameAgentId);
  const passwordAgent = agents.find((agent) => agent.id === passwordAgentId);

  function applyFilters() {
    setApplied({ query, status, plan });
    setPage(1);
  }

  function flash(text: string) {
    setNotice(text);
  }

  return (
    <div className="space-y-6">
      {notice ? (
        <div className="km-panel flex items-center justify-between gap-3 text-sm">
          <span>{notice}</span>
          <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice("")}>
            知道了
          </button>
        </div>
      ) : null}

      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">代理管理</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              代理用同一套登录页进入自己的后台改零售价。登录 <span className="underline">/login</span>
              ，上手说明 <span className="underline">/start</span>。新建时会复制一份开户说明，列表里也能再复制。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="km-btn km-btn-ghost" onClick={() => flash("已刷新。静态稿不连服务器。")}>
              刷新
            </button>
            <button type="button" className="km-btn" onClick={() => setCreateOpen(true)}>
              新建代理
            </button>
          </div>
        </div>
        <label className="block space-y-1 text-sm">
          <span>兑换页面地址</span>
          <input className="km-input w-full" value={redeemUrl} onChange={(event) => setRedeemUrl(event.target.value)} />
          <span className="block text-xs text-[var(--km-fg-muted)]">
            代理后台的「兑换卡密」按钮跳这里。默认就是本站 <code className="mx-1">/recharge</code>
            。要换到别处才填完整网址。
          </span>
        </label>
        <button type="button" className="km-btn" onClick={() => flash(`兑换页面已记为 ${redeemUrl || "/recharge"}`)}>
          保存兑换页面地址
        </button>
      </section>

      <section className="km-panel space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">默认成本价</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              {PLAN_OPTIONS.length} 个在售方向 · 会员、续费、点数、成品号。即时发卡不再放一份。
            </p>
          </div>
          <button type="button" className="km-btn km-btn-ghost km-btn-sm shrink-0" onClick={() => setCostsOpen((value) => !value)}>
            {costsOpen ? "收起" : "展开"}
          </button>
        </div>
        {costsOpen ? (
          <>
            <PlanPricesPreview embedded />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="km-btn" onClick={() => flash("默认价格已留在这页。接入后才会写入数据库。")}>
                保存默认价格
              </button>
              <button type="button" className="km-btn km-btn-ghost" onClick={() => flash("已勾选且已定价的套餐，会开放给全部启用中的代理。")}>
                把已勾选的套餐开放给全部代理
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-[var(--km-fg-muted)]">点开再改成本和上限。没展开时不会出现保存按钮。</p>
        )}
      </section>

      <section className="km-panel space-y-4">
        <h2 className="text-xl font-semibold">代理账号</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="block text-xs font-medium text-[var(--km-fg-muted)]">
            关键词
            <input
              className="km-input mt-1 w-full text-sm font-normal text-[var(--km-fg)]"
              placeholder="代理名、用户名、店铺"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilters();
              }}
            />
          </label>
          <label className="block text-xs font-medium text-[var(--km-fg-muted)]">
            状态
            <span className="mt-1 block">
              <KmSelect
                value={status}
                placeholder="全部"
                options={[
                  { value: "", label: "全部" },
                  { value: "active", label: "启用" },
                  { value: "disabled", label: "停用" },
                ]}
                onChange={setStatus}
              />
            </span>
          </label>
          <label className="block text-xs font-medium text-[var(--km-fg-muted)]">
            可售套餐
            <span className="mt-1 block">
              <KmSelect
                value={plan}
                placeholder="不限"
                options={[{ value: "", label: "不限" }, ...PLAN_OPTIONS.map((item) => ({ value: item.key, label: item.name }))]}
                onChange={setPlan}
              />
            </span>
          </label>
          <div className="flex items-end gap-2">
            <button type="button" className="km-btn km-btn-sm" onClick={applyFilters}>
              查询
            </button>
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              onClick={() => {
                setQuery("");
                setStatus("");
                setPlan("");
                setApplied({ query: "", status: "", plan: "" });
                setPage(1);
              }}
            >
              清空
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-3 pr-4">代理</th>
                <th className="py-3 pr-4">用户名</th>
                <th className="py-3 pr-4">店铺</th>
                <th className="py-3 pr-4">可售套餐</th>
                <th className="whitespace-nowrap py-3 pr-6">状态</th>
                <th className="whitespace-nowrap py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--km-fg-muted)]">
                    没有符合条件的代理。
                  </td>
                </tr>
              ) : null}
              {rows.map((agent) => (
                <tr key={agent.id} className="border-b border-[var(--km-border)]">
                  <td className="py-3 pr-4">
                    <div>{agent.name}</div>
                    {agent.realName ? <div className="text-xs text-[var(--km-fg-muted)]">{agent.realName}</div> : null}
                  </td>
                  <td className="py-3 pr-4 font-mono">{agent.username}</td>
                  <td className="py-3 pr-4">
                    <span className="underline">/s/{agent.slug}</span>
                  </td>
                  <td className="py-3 pr-4">
                    {agent.plans.length ? (
                      <span className="flex flex-wrap gap-1">
                        {agent.plans.map((key) => (
                          <span key={key} className="km-badge">
                            {planName(key).replace(" · 菲区", "")}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-[var(--km-fg-muted)]">未分配</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-3 pr-6">{agent.status === "active" ? "启用" : "停用"}</td>
                  <td className="py-3">
                    <RowMenu
                      open={menuId === agent.id}
                      active={agent.status === "active"}
                      onToggle={() => setMenuId((current) => (current === agent.id ? 0 : agent.id))}
                      onClose={() => setMenuId(0)}
                      onPlans={() => setPlanAgentId(agent.id)}
                      onCopy={() => flash(`${agent.name} 的开户说明已复制（不含密码）。登录 /login ，店铺 /s/${agent.slug}`)}
                      onReset={() => setPasswordAgentId(agent.id)}
                      onName={() => setNameAgentId(agent.id)}
                      onStatus={() => {
                        setAgents((current) =>
                          current.map((item) =>
                            item.id === agent.id
                              ? { ...item, status: item.status === "active" ? "disabled" : "active" }
                              : item,
                          ),
                        );
                        flash(agent.status === "active" ? `${agent.name} 已停用` : `${agent.name} 已启用`);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--km-fg-muted)]">
          <span>
            共 {filtered.length} 个，第 {pageSafe} / {pages} 页，每页 {PAGE_SIZE} 条
          </span>
          <div className="flex gap-2">
            <button type="button" className="km-btn km-btn-ghost km-btn-sm" disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>
              上一页
            </button>
            <button type="button" className="km-btn km-btn-ghost km-btn-sm" disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>
              下一页
            </button>
          </div>
        </div>
      </section>

      {createOpen ? (
        <CreateAgentDialog
          onClose={() => setCreateOpen(false)}
          onCreate={(agent) => {
            setAgents((current) => [agent, ...current]);
            setCreateOpen(false);
            flash(`${agent.name} 已创建，开户说明已复制。`);
          }}
          nextId={Math.max(...agents.map((agent) => agent.id)) + 1}
        />
      ) : null}
      {planAgent ? (
        <PlanDialog
          agent={planAgent}
          onClose={() => setPlanAgentId(0)}
          onSave={(plans) => {
            setAgents((current) => current.map((item) => (item.id === planAgent.id ? { ...item, plans } : item)));
            setPlanAgentId(0);
            flash(`${planAgent.name} 的可售套餐已更新`);
          }}
        />
      ) : null}
      {nameAgent ? (
        <NameDialog
          agent={nameAgent}
          onClose={() => setNameAgentId(0)}
          onSave={(realName) => {
            setAgents((current) => current.map((item) => (item.id === nameAgent.id ? { ...item, realName } : item)));
            setNameAgentId(0);
            flash("真实姓名已更新");
          }}
        />
      ) : null}
      {passwordAgent ? (
        <PasswordDialog
          agent={passwordAgent}
          onClose={() => setPasswordAgentId(0)}
          onSave={() => {
            setPasswordAgentId(0);
            flash(`${passwordAgent.name} 的密码已重置。静态稿不会真的改登录。`);
          }}
        />
      ) : null}
    </div>
  );
}

function RowMenu({
  open,
  active,
  onToggle,
  onClose,
  onPlans,
  onCopy,
  onReset,
  onName,
  onStatus,
}: {
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPlans: () => void;
  onCopy: () => void;
  onReset: () => void;
  onName: () => void;
  onStatus: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; up: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const up = window.innerHeight - rect.bottom < 220;
    setBox({ top: up ? rect.top - 6 : rect.bottom + 6, left: Math.max(8, rect.right - 148), up });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open, onClose]);

  const items = [
    { label: "套餐", run: onPlans },
    { label: "复制开户说明", run: onCopy },
    { label: "重置密码", run: onReset },
    { label: "真实姓名", run: onName },
  ];

  return (
    <>
      <button ref={buttonRef} type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={onToggle}>
        操作
      </button>
      {open && box
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-40 w-36 rounded-xl border border-[var(--km-border)] bg-[var(--km-bg-elevated)] py-1 shadow-lg"
              style={{ top: box.top, left: box.left, transform: box.up ? "translateY(-100%)" : undefined }}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--km-bg-muted)]"
                  onClick={() => {
                    onClose();
                    item.run();
                  }}
                >
                  {item.label}
                </button>
              ))}
              <div className="my-1 border-t border-[var(--km-border)]" />
              <button
                type="button"
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-[var(--km-bg-muted)] ${active ? "text-red-600" : ""}`}
                onClick={() => {
                  onClose();
                  onStatus();
                }}
              >
                {active ? "停用" : "启用"}
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function CreateAgentDialog({
  nextId,
  onClose,
  onCreate,
}: {
  nextId: number;
  onClose: () => void;
  onCreate: (agent: AgentRow) => void;
}) {
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [slug, setSlug] = useState("");
  const [plans, setPlans] = useState<string[]>(["plus-ph", "gpt"]);
  const [error, setError] = useState("");

  return (
    <Modal title="新建代理" hint="填登录信息，并勾选这个代理能卖的套餐。" onClose={onClose}>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="登录用户名">
          <input className="km-input w-full" value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field label="显示名">
          <input className="km-input w-full" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="初始密码（至少 8 位）">
          <input className="km-input w-full" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Field label="店铺 slug（可空）">
          <input className="km-input w-full" value={slug} onChange={(event) => setSlug(event.target.value)} />
        </Field>
      </div>
      <div className="mt-4 space-y-2">
        <p className="text-sm font-medium">可售套餐</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {PLAN_OPTIONS.map((plan) => (
            <label key={plan.key} className="flex items-center gap-2 rounded-xl border border-[var(--km-border)] px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={plans.includes(plan.key)}
                onChange={() => setPlans((current) => (current.includes(plan.key) ? current.filter((key) => key !== plan.key) : [...current, plan.key]))}
              />
              <span>
                {plan.name}
                <span className="ml-2 text-xs text-[var(--km-fg-muted)]">成本 ¥{plan.cost}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="km-btn km-btn-ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="km-btn"
          onClick={() => {
            if (!username.trim() || !name.trim()) {
              setError("用户名和显示名都要填");
              return;
            }
            if (password.trim().length < 8) {
              setError("初始密码至少 8 位");
              return;
            }
            onCreate({
              id: nextId,
              name: name.trim(),
              username: username.trim(),
              slug: slug.trim() || username.trim(),
              realName: "",
              status: "active",
              plans,
            });
          }}
        >
          创建
        </button>
      </div>
    </Modal>
  );
}

function PlanDialog({
  agent,
  onClose,
  onSave,
}: {
  agent: AgentRow;
  onClose: () => void;
  onSave: (plans: string[]) => void;
}) {
  const [plans, setPlans] = useState(agent.plans);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  return (
    <Modal wide title={`${agent.name} 的可售套餐`} hint="勾选后代理才能卖。成本留空则用默认成本。零售价由代理自己登录后改。" onClose={onClose}>
      <div className="mt-4 flex justify-end">
        <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setPlans(PLAN_OPTIONS.map((plan) => plan.key))}>
          全选平台已启用
        </button>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]">
              <th className="py-2 pr-3">允许销售</th>
              <th className="py-2 pr-3">套餐</th>
              <th className="py-2 pr-3">默认成本</th>
              <th className="py-2 pr-3">零售价上限</th>
              <th className="py-2 pr-3">代理成本覆盖</th>
              <th className="py-2">当前零售价</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_OPTIONS.map((plan) => (
              <tr key={plan.key} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">
                  <input
                    type="checkbox"
                    checked={plans.includes(plan.key)}
                    onChange={() =>
                      setPlans((current) => (current.includes(plan.key) ? current.filter((key) => key !== plan.key) : [...current, plan.key]))
                    }
                  />
                </td>
                <td className="py-2 pr-3">{plan.name}</td>
                <td className="py-2 pr-3">¥{plan.cost}</td>
                <td className="py-2 pr-3">{plan.cap ? `¥${plan.cap}` : "不限价"}</td>
                <td className="py-2 pr-3">
                  <input
                    className="km-input w-28"
                    placeholder="用默认"
                    value={overrides[plan.key] || ""}
                    onChange={(event) => setOverrides((current) => ({ ...current, [plan.key]: event.target.value }))}
                  />
                </td>
                <td className="py-2 text-[var(--km-fg-muted)]">{plans.includes(plan.key) ? "代理未改" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="km-btn km-btn-ghost" onClick={onClose}>
          关闭
        </button>
        <button type="button" className="km-btn" onClick={() => onSave(plans)}>
          保存套餐
        </button>
      </div>
    </Modal>
  );
}

function NameDialog({ agent, onClose, onSave }: { agent: AgentRow; onClose: () => void; onSave: (name: string) => void }) {
  const [value, setValue] = useState(agent.realName);
  return (
    <Modal title="真实姓名" hint="只给后台看，前台和代理自己都看不到。" onClose={onClose}>
      <label className="mt-4 block text-sm">
        真实姓名
        <input className="km-input mt-1 w-full" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="km-btn km-btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="km-btn" onClick={() => onSave(value.trim())}>
          保存
        </button>
      </div>
    </Modal>
  );
}

function PasswordDialog({ agent, onClose, onSave }: { agent: AgentRow; onClose: () => void; onSave: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title={`重置 ${agent.name} 的密码`} hint="重置后请把新密码发给代理。这里不会显示旧密码。" onClose={onClose}>
      <div className="mt-4 space-y-3">
        <Field label="新密码">
          <input className="km-input w-full" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Field label="再输一次">
          <input className="km-input w-full" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="km-btn km-btn-ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="km-btn"
          onClick={() => {
            if (password.length < 8) {
              setError("至少 8 位");
              return;
            }
            if (password !== confirm) {
              setError("两次不一致");
              return;
            }
            onSave();
          }}
        >
          重置
        </button>
      </div>
    </Modal>
  );
}

type DrawItem = {
  id: number;
  at: string;
  drawNo: string;
  plan: string;
  region: string;
  code: string;
  use: string;
  amount: number;
};

const DRAW_AGENTS = [
  { id: 1, name: "HelloAI", status: "已开通", unsettled: 420, count: 3, settled: 860, settledCount: 6, lifetime: 1280, lifetimeCount: 9, credit: 3000 },
  { id: 2, name: "huyazhou", status: "已开通", unsettled: 226, count: 2, settled: 90, settledCount: 1, lifetime: 316, lifetimeCount: 3, credit: 3000 },
  { id: 3, name: "kabuqinoo", status: "已暂停", unsettled: 0, count: 0, settled: 148.5, settledCount: 1, lifetime: 148.5, lifetimeCount: 1, credit: 1000 },
];

const DRAW_ITEMS: Record<number, DrawItem[]> = {
  1: [
    { id: 11, at: "10-04 21:02", drawNo: "DR20261004881", plan: "Pro 20x", region: "", code: "KM-****-8R61", use: "未使用", amount: 175 },
    { id: 12, at: "10-03 18:11", drawNo: "DR20261003220", plan: "Plus", region: "CL", code: "KM-****-2210", use: "已兑换", amount: 115 },
    { id: 13, at: "10-02 09:40", drawNo: "DR20261002019", plan: "Codex 点数 250", region: "", code: "KM-****-0194", use: "手动核销", amount: 130 },
  ],
  2: [
    { id: 21, at: "10-04 16:20", drawNo: "DR20261004402", plan: "Plus", region: "", code: "KM-****-4402", use: "未使用", amount: 115 },
    { id: 22, at: "10-01 11:08", drawNo: "DR20261001108", plan: "Plus", region: "CL", code: "KM-****-1108", use: "未使用", amount: 111 },
  ],
  3: [],
};

export function AgentDrawPreview() {
  const [view, setView] = useState<"ledger" | "bills" | "apply">("ledger");
  const [agentId, setAgentId] = useState(1);
  const [checked, setChecked] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [settleOpen, setSettleOpen] = useState(false);
  const [manualId, setManualId] = useState(0);
  const [voidId, setVoidId] = useState(0);
  const [reason, setReason] = useState("");
  const [voidMode, setVoidMode] = useState<"upstream" | "local">("upstream");
  const [credit, setCredit] = useState("3000");
  const [perDraw, setPerDraw] = useState("5");
  const [daily, setDaily] = useState("0");
  const [notify, setNotify] = useState(true);
  const [notice, setNotice] = useState("");
  const [billOpen, setBillOpen] = useState(true);
  const [removed, setRemoved] = useState<number[]>([]);
  const agent = DRAW_AGENTS.find((item) => item.id === agentId) || DRAW_AGENTS[0];
  const items = (DRAW_ITEMS[agent.id] || []).filter((item) => !removed.includes(item.id));
  const visible = items.filter((item) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [item.drawNo, item.plan, item.code].join(" ").toLowerCase().includes(q);
  });
  const selected = visible.filter((item) => checked.includes(item.id));
  const selectedSum = selected.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="space-y-4">
      {notice ? <div className="km-panel text-sm">{notice}</div> : null}
      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="待审批" value="1" />
        <Stat label="已开通代理" value="3" />
        <Stat label="未结算" value="¥646.00" hint="5 张" />
      </section>
      <div className="km-tabs">
        {(
          [
            ["ledger", "未结算账本"],
            ["bills", "结算归档"],
            ["apply", "申请 1"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={`km-tab ${view === id ? "km-tab-active" : ""}`} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </div>

      {view === "ledger" ? (
        <section className="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="km-panel space-y-1">
            <h2 className="mb-2 font-semibold">代理</h2>
            {DRAW_AGENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`block w-full rounded-xl px-3 py-2.5 text-left ${item.id === agent.id ? "bg-[var(--km-bg-muted)]" : "hover:bg-[var(--km-bg-muted)]"}`}
                onClick={() => {
                  setAgentId(item.id);
                  setChecked([]);
                  setSettleOpen(false);
                  setCredit(String(item.credit));
                }}
              >
                <span className="flex items-center justify-between gap-2">
                  <b className="truncate text-sm">{item.name}</b>
                  <span className="shrink-0 text-[11px] text-[var(--km-fg-muted)]">{item.status}</span>
                </span>
                <span className="mt-1 block text-xs">未结 ¥{item.unsettled.toFixed(2)} · {item.count} 张</span>
                <span className="block text-xs text-[var(--km-fg-muted)]">
                  历史 ¥{item.lifetime.toFixed(2)} · {item.lifetimeCount} 张
                </span>
              </button>
            ))}
          </div>
          <div className="km-panel space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold">{agent.name}</h2>
                  <span className="rounded-full bg-[var(--km-bg-muted)] px-2 py-0.5 text-xs">{agent.status}</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Mini label="未结" value={`¥${agent.unsettled.toFixed(2)}`} hint={`${agent.count} 张`} />
                  <Mini label="已结算" value={`¥${agent.settled.toFixed(2)}`} hint={`${agent.settledCount} 张`} />
                  <Mini label="历史提卡" value={`¥${agent.lifetime.toFixed(2)}`} hint={`${agent.lifetimeCount} 张`} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice("导出会下载这个代理的未结卡密。静态稿先不生成文件。")}>
                  导出
                </button>
                <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setView("bills")}>
                  查结算
                </button>
                <button type="button" className="km-btn km-btn-sm" disabled={!selected.length} onClick={() => setSettleOpen(true)}>
                  登记结算{selected.length ? ` ¥${selectedSum.toFixed(2)}` : ""}
                </button>
              </div>
            </div>
            <div className="rounded-2xl border border-[var(--km-border)] p-4">
              <p className="text-sm font-medium">提卡设置</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field label="上限" hint="元">
                  <input className="km-input w-full" value={credit} onChange={(event) => setCredit(event.target.value)} />
                </Field>
                <Field label="单次最多" hint="张">
                  <input className="km-input w-full" value={perDraw} onChange={(event) => setPerDraw(event.target.value)} />
                </Field>
                <Field label="每日最多" hint="0 = 不限">
                  <input className="km-input w-full" value={daily} onChange={(event) => setDaily(event.target.value)} />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
                  每次提卡发 Telegram
                </label>
                <div className="flex gap-2">
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice(`${agent.name} 的提卡设置已记下：上限 ¥${credit}`)}>
                    保存设置
                  </button>
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice(agent.status === "已暂停" ? "已恢复提卡" : "已暂停提卡")}>
                    {agent.status === "已暂停" ? "恢复提卡" : "暂停提卡"}
                  </button>
                </div>
              </div>
            </div>
            {settleOpen ? (
              <div className="space-y-3 rounded-2xl border border-[var(--km-border)] p-4 text-sm">
                <p className="font-medium">
                  登记结算 · {agent.name} · {selected.length} 张 · ¥{selectedSum.toFixed(2)}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="收款方式">
                    <KmSelect
                      value="alipay"
                      options={[
                        { value: "alipay", label: "支付宝" },
                        { value: "wechat", label: "微信" },
                        { value: "bank", label: "银行卡" },
                      ]}
                      onChange={() => undefined}
                    />
                  </Field>
                  <Field label="流水号">
                    <input className="km-input w-full" placeholder="可空" />
                  </Field>
                  <Field label="备注">
                    <input className="km-input w-full" placeholder="可空" />
                  </Field>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="km-btn km-btn-ghost" onClick={() => setSettleOpen(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="km-btn"
                    onClick={() => {
                      setRemoved((current) => [...current, ...selected.map((item) => item.id)]);
                      setChecked([]);
                      setSettleOpen(false);
                      setNotice(`已结算 ${selected.length} 张，¥${selectedSum.toFixed(2)}。这些卡会进结算归档。`);
                    }}
                  >
                    确认已收到 ¥{selectedSum.toFixed(2)}
                  </button>
                </div>
              </div>
            ) : null}
            {manualId ? (
              <ActionBox
                title={`手动核销 ${items.find((item) => item.id === manualId)?.code || ""}`}
                hint="会向卡台退卡。卡密不能再兑换，金额仍算这个代理的未结。"
                reason={reason}
                onReason={setReason}
                confirm="核销并退卡台"
                onCancel={() => setManualId(0)}
                onConfirm={() => {
                  setNotice("已手动核销，金额仍在未结里");
                  setManualId(0);
                  setReason("");
                }}
              />
            ) : null}
            {voidId ? (
              <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
                <p>作废 {items.find((item) => item.id === voidId)?.code}</p>
                <p className="text-[var(--km-fg-muted)]">作废后不再计入欠款。误提、退卡才用这个。</p>
                <label className="block">
                  <input type="radio" checked={voidMode === "upstream"} onChange={() => setVoidMode("upstream")} /> 退卡台（删卡退款）
                </label>
                <label className="block">
                  <input type="radio" checked={voidMode === "local"} onChange={() => setVoidMode("local")} /> 只在本系统作废（卡台已手动处理过）
                </label>
                <input className="km-input w-full" placeholder="原因" value={reason} onChange={(event) => setReason(event.target.value)} />
                <div className="flex gap-2">
                  <button type="button" className="km-btn km-btn-ghost" onClick={() => setVoidId(0)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="km-btn"
                    disabled={!reason.trim()}
                    onClick={() => {
                      setRemoved((current) => [...current, voidId]);
                      setVoidId(0);
                      setReason("");
                      setNotice("已作废，这张不再计入欠款");
                    }}
                  >
                    作废
                  </button>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Field label="筛选未结卡密">
                <input className="km-input w-64" placeholder="单号、卡密或套餐" value={query} onChange={(event) => setQuery(event.target.value)} />
              </Field>
              <p className="text-xs text-[var(--km-fg-muted)]">{visible.length} 张</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--km-border)]">
                    <th className="py-2 pr-3" />
                    <th className="py-2 pr-3">时间</th>
                    <th className="py-2 pr-3">提卡单</th>
                    <th className="py-2 pr-3">套餐</th>
                    <th className="py-2 pr-3">卡密</th>
                    <th className="py-2 pr-3">使用</th>
                    <th className="py-2 pr-3">金额</th>
                    <th className="py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-[var(--km-fg-muted)]">
                        {items.length === 0 ? "这个代理没有未结算的提卡。" : "没有符合筛选的卡密。"}
                      </td>
                    </tr>
                  ) : null}
                  {visible.map((item) => (
                    <tr key={item.id} className="border-b border-[var(--km-border)]">
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          checked={checked.includes(item.id)}
                          onChange={(event) =>
                            setChecked((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))
                          }
                        />
                      </td>
                      <td className="py-2 pr-3">{item.at}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{item.drawNo}</td>
                      <td className="py-2 pr-3">
                        {item.plan} {item.region ? <RegionBadge country={item.region} /> : <RegionBadge country="" regionLabel="菲区" />}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{item.code}</td>
                      <td className="py-2 pr-3">{item.use}</td>
                      <td className="py-2 pr-3">¥{item.amount.toFixed(2)}</td>
                      <td className="py-2">
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setManualId(item.id)}>
                          手动核销
                        </button>
                        <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setVoidId(item.id)}>
                          作废
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {view === "bills" ? (
        <section className="km-panel space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="代理">
              <KmSelect value="" placeholder="全部" options={[{ value: "", label: "全部" }, ...DRAW_AGENTS.map((item) => ({ value: String(item.id), label: item.name }))]} onChange={() => undefined} />
            </Field>
            <Field label="关键词" hint="账单号 / 流水号 / 备注">
              <input className="km-input w-full" placeholder="例如 DB 或流水号" />
            </Field>
            <Field label="收款方式">
              <KmSelect value="" options={[{ value: "", label: "全部" }, { value: "alipay", label: "支付宝" }]} onChange={() => undefined} />
            </Field>
            <Field label="状态">
              <KmSelect value="" options={[{ value: "", label: "全部" }, { value: "settled", label: "已结算" }, { value: "reverted", label: "已撤销" }]} onChange={() => undefined} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="km-btn km-btn-sm">查询</button>
            <button type="button" className="km-btn km-btn-ghost km-btn-sm">清空</button>
            <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice("导出会按当前筛选出 CSV。")}>导出 CSV</button>
          </div>
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)] text-xs text-[var(--km-fg-muted)]">
                <th className="py-2 pr-3">账单号</th>
                <th className="py-2 pr-3">代理</th>
                <th className="py-2 pr-3">时间</th>
                <th className="py-2 pr-3">张数</th>
                <th className="py-2 pr-3">金额</th>
                <th className="py-2 pr-3">方式</th>
                <th className="py-2 pr-3">流水号</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-2 pr-3 font-mono text-xs">DB20261003001</td>
                <td className="py-2 pr-3">HelloAI</td>
                <td className="py-2 pr-3">10-03 12:08</td>
                <td className="py-2 pr-3">4</td>
                <td className="py-2 pr-3">¥860.00</td>
                <td className="py-2 pr-3">支付宝</td>
                <td className="py-2 pr-3">20261003…</td>
                <td className="py-2 pr-3">已结算</td>
                <td className="py-2">
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setBillOpen((value) => !value)}>
                    {billOpen ? "收起" : "明细"}
                  </button>
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice("7 天内可撤销。撤销后这些卡回到未结算。")}>
                    撤销
                  </button>
                </td>
              </tr>
              {billOpen ? (
                <tr>
                  <td colSpan={9} className="bg-[var(--km-bg-muted)] px-3 py-3">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="text-[var(--km-fg-muted)]">
                          <th className="py-1 pr-3">时间</th>
                          <th className="py-1 pr-3">提卡单</th>
                          <th className="py-1 pr-3">套餐</th>
                          <th className="py-1 pr-3">卡密</th>
                          <th className="py-1 pr-3">使用</th>
                          <th className="py-1">金额</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-t border-[var(--km-border)]">
                          <td className="py-2 pr-3">10-02 09:12</td>
                          <td className="py-2 pr-3 font-mono">DR…771</td>
                          <td className="py-2 pr-3">Pro 5x</td>
                          <td className="py-2 pr-3 font-mono">KM-****-7712</td>
                          <td className="py-2 pr-3">已兑换</td>
                          <td className="py-2">¥215.00</td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="text-xs text-[var(--km-fg-muted)]">这是提卡欠款的结算，现在已并入「对账」，和商店收益一起按代理结清。</p>
        </section>
      ) : null}

      {view === "apply" ? (
        <section className="km-panel space-y-3 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full max-w-xs">
              <Field label="直接开通">
                <KmSelect value="6" options={[{ value: "6", label: "kabuqinoo" }]} onChange={() => undefined} />
              </Field>
            </div>
            <button type="button" className="km-btn" onClick={() => setNotice("已开通，默认上限 ¥3,000")}>
              开通提卡
            </button>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)]">
                <th className="py-2 pr-3">代理</th>
                <th className="py-2 pr-3">联系方式</th>
                <th className="py-2 pr-3">预计用量</th>
                <th className="py-2 pr-3">说明</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-2 pr-3">小浣熊的店</td>
                <td className="py-2 pr-3">@why</td>
                <td className="py-2 pr-3">每月 30 张</td>
                <td className="py-2 pr-3">先试 Plus</td>
                <td className="py-2">
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice("小浣熊的店 已开通")}>
                    通过
                  </button>
                  <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setNotice("已拒绝，原因会给代理看")}>
                    拒绝
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

export function AgentEarningsPreview() {
  const [preset, setPreset] = useState("week");
  const [grain, setGrain] = useState("day");
  return (
    <div className="space-y-6">
      <section className="km-panel space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">收益统计</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              平台毛利 = 代理成本 + 开票加价 − 上游进价 − 平台手续费。没配进价的单不计入毛利。要结给代理的金额请到「对账」，周结已停用，旧单在「历史周结」。
            </p>
          </div>
          <button type="button" className="km-btn km-btn-ghost km-btn-sm">
            导出这段 Excel
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            ["today", "今天"],
            ["week", "本周"],
            ["month", "本月"],
            ["custom", "自定义"],
          ].map(([id, label]) => (
            <button key={id} type="button" className={`km-tab ${preset === id ? "km-tab-active" : ""}`} onClick={() => setPreset(id)}>
              {label}
            </button>
          ))}
          <span className="mx-1 hidden h-6 w-px bg-[var(--km-border)] sm:block" />
          {[
            ["day", "按天"],
            ["week", "按周"],
            ["month", "按月"],
          ].map(([id, label]) => (
            <button key={id} type="button" className={`km-tab ${grain === id ? "km-tab-active" : ""}`} onClick={() => setGrain(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <p className="self-center text-sm text-[var(--km-fg-muted)] md:col-span-2">2026-09-29 至 2026-10-05</p>
          <KmSelect value="" placeholder="全部代理" options={[{ value: "", label: "全部代理" }, ...SEED.map((agent) => ({ value: String(agent.id), label: agent.name }))]} onChange={() => undefined} />
        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="货款" value="¥18,420" hint="86 单" />
        <Stat label="平台毛利" value="¥2,140" hint="占货款 11%" />
        <Stat label="代理收益" value="¥1,086" />
        <Stat label="客单" value="¥214" />
      </div>
      <section className="km-panel space-y-3">
        <h3 className="font-semibold">毛利与代理收益</h3>
        <div className="flex h-36 items-end gap-3">
          {[
            ["09-29", 42, 28],
            ["09-30", 55, 30],
            ["10-01", 36, 22],
            ["10-02", 70, 40],
            ["10-03", 62, 34],
            ["10-04", 48, 26],
            ["10-05", 80, 44],
          ].map(([label, profit, agent]) => (
            <div key={String(label)} className="flex flex-1 items-end justify-center gap-1">
              <div className="w-3 rounded-t bg-[var(--km-fg)]" style={{ height: `${profit}%` }} title="平台毛利" />
              <div className="w-3 rounded-t bg-[var(--km-fg-muted)]" style={{ height: `${agent}%` }} title="代理收益" />
            </div>
          ))}
        </div>
        <p className="text-xs text-[var(--km-fg-muted)]">深色是平台毛利，浅色是代理收益。</p>
      </section>
      <section className="km-panel space-y-3">
        <h3 className="font-semibold">各代理收益</h3>
        {[
          ["HelloAI", "¥620.00", 78],
          ["huyazhou", "¥210.00", 36],
          ["Polus", "¥96.00", 18],
          ["小浣熊的店", "¥160.00", 28],
        ].map(([name, money, width]) => (
          <div key={String(name)} className="grid grid-cols-[7rem_1fr_5.5rem] items-center gap-3 text-sm">
            <span className="truncate text-[var(--km-fg-muted)]">{name}</span>
            <span className="h-2 overflow-hidden rounded-full bg-[var(--km-bg-muted)]">
              <span className="block h-full rounded-full bg-[var(--km-fg)]" style={{ width: `${width}%` }} />
            </span>
            <span>{money}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function ActionBox({
  title,
  hint,
  reason,
  onReason,
  confirm,
  onCancel,
  onConfirm,
}: {
  title: string;
  hint: string;
  reason: string;
  onReason: (value: string) => void;
  confirm: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-[var(--km-border)] p-3 text-sm">
      <p>{title}</p>
      <p className="text-[var(--km-fg-muted)]">{hint}</p>
      <input className="km-input w-full" placeholder="原因，例如已手动充值" value={reason} onChange={(event) => onReason(event.target.value)} />
      <div className="flex gap-2">
        <button type="button" className="km-btn km-btn-ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="km-btn" disabled={!reason.trim()} onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </div>
  );
}

function Modal({
  title,
  hint,
  wide,
  onClose,
  children,
}: {
  title: string;
  hint: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="km-modal-backdrop" onClick={onClose}>
      <div className={`km-modal ${wide ? "km-modal-wide" : ""}`} onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">{hint}</p>
          </div>
          <button type="button" className="km-btn km-btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span>
        {label}
        {hint ? <span className="ml-1 text-xs text-[var(--km-fg-muted)]">{hint}</span> : null}
      </span>
      <span className="mt-1 block">{children}</span>
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

function Mini({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-2">
      <p className="text-[11px] text-[var(--km-fg-muted)]">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
      <p className="text-[11px] text-[var(--km-fg-muted)]">{hint}</p>
    </div>
  );
}
