"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";

type Account = {
  id: number;
  name: string;
  protocol: string;
  protocolLabel: string;
  siteBase: string;
  enabled: boolean;
  isDefault: boolean;
  priority: number;
  webhookUrl: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  webhookSecretConfigured: boolean;
  webhookSecretHint: string;
  lastError: string;
  lastOkAt: string | null;
  lastProductsSyncAt: string | null;
};

type EventRow = {
  id: number;
  accountId: number;
  eventType: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

function formatWhen(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function summarizeEvent(payload: Record<string, unknown>) {
  return String(
    payload.event ||
      payload.type ||
      payload.status ||
      payload.message ||
      payload.msg ||
      "",
  );
}

export function CardIntegration({ publicBaseUrl = "" }: { publicBaseUrl?: string }) {
  const [busy, setBusy] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<number | "new" | null>(null);
  const [egressIp, setEgressIp] = useState("");
  const [egressIpv6, setEgressIpv6] = useState("");
  const [egressHint, setEgressHint] = useState("");
  const [egressError, setEgressError] = useState("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [form, setForm] = useState({
    name: "主台 A",
    protocol: "spacexcard-legacy",
    siteBase: "",
    apiKey: "",
    webhookSecret: "",
    enabled: true,
    isDefault: true,
    priority: 10,
    webhookUrl: "",
  });

  const selected = accounts.find((item) => item.id === selectedId) || null;

  const selectedEvents = useMemo(
    () =>
      events
        .filter((item) => !selected || item.accountId === selected.id)
        .slice(0, 8),
    [events, selected],
  );

  function notice(text: string, kind: "ok" | "err" = "ok") {
    toast(text, kind);
  }

  async function loadAccounts(preferId?: number) {
    const data = await readApiJson(
      await fetch("/api/admin/cardplatform/accounts", { cache: "no-store" }),
    );
    const list = (data.list || []) as Account[];
    setAccounts(list);
    const nextId =
      preferId ||
      (typeof selectedId === "number" ? selectedId : null) ||
      list.find((item) => item.isDefault)?.id ||
      list[0]?.id ||
      (list.length === 0 ? "new" : null);
    setSelectedId(nextId);
    return list;
  }

  async function loadAccountExtras(id: number) {
    const ev = await readApiJson(
      await fetch(`/api/admin/cardplatform/webhook-events?accountId=${id}`, {
        cache: "no-store",
      }),
    );
    setEvents(ev.events || []);
  }

  async function loadEgress() {
    const data = await readApiJson(
      await fetch("/api/admin/network/egress", { cache: "no-store" }),
    );
    setEgressIp(data.egressIp || data.egressIpv4 || "");
    setEgressIpv6(data.egressIpv6 || "");
    setEgressHint(data.whitelistHint || "");
    setEgressError(data.egressError || "");
  }

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([loadAccounts(), loadEgress()]);
      } catch (error) {
        notice(error instanceof Error ? error.message : "加载失败", "err");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof selectedId !== "number") {
      setForm({
        name: accounts.length ? "备台" : "主台 A",
        protocol: "spacexcard-legacy",
        siteBase: "",
        apiKey: "",
        webhookSecret: "",
        enabled: true,
        isDefault: accounts.length === 0,
        priority: accounts.length ? 20 : 10,
        webhookUrl: "",
      });
      return;
    }
    const account = accounts.find((item) => item.id === selectedId);
    if (!account) return;
    setForm({
      name: account.name,
      protocol: account.protocol,
      siteBase: account.siteBase,
      apiKey: "",
      webhookSecret: "",
      enabled: account.enabled,
      isDefault: account.isDefault,
      priority: account.priority,
      webhookUrl: account.webhookUrl,
    });
    void loadAccountExtras(account.id).catch((error) => {
      notice(error instanceof Error ? error.message : "读取账户配置失败", "err");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, accounts.map((item) => item.id).join(",")]);

  async function run(name: string, work: () => Promise<void>) {
    setBusy(name);
    try {
      await work();
    } catch (error) {
      notice(error instanceof Error ? error.message : "操作失败", "err");
      if (
        typeof selectedId === "number" &&
        ["ping", "connect", "price", "balance", "save", "sync-plans"].includes(name)
      ) {
        await loadAccounts(selectedId).catch(() => undefined);
      }
    } finally {
      setBusy("");
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
    notice("已复制");
  }

  return (
    <div className="space-y-4">
      <div className="km-panel space-y-3">
        <div>
          <h2 className="text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            卡台接入
          </h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            多账户、协议、出口 IP 和 Webhook 在这里配。选卡优先级和兑换策略在「选卡配置」。
            本站不发双绑码，每单只从指定账户出一张卡。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--km-bg-muted)] px-3 py-3">
          <div>
            <p className="text-xs text-[var(--km-fg-muted)]">本机出口 IPv4</p>
            <p className="font-mono text-lg">{egressIp || egressError || "未探测到 IPv4"}</p>
            {egressIpv6 ? (
              <p className="font-mono text-xs text-[var(--km-fg-muted)]">IPv6 {egressIpv6}</p>
            ) : null}
          </div>
          <p className="flex-1 text-sm text-[var(--km-fg-muted)]">
            {egressHint || "请把 IPv4 加到卡台 API Key 白名单，否则连通会 403。"}
          </p>
          <button
            type="button"
            className="km-btn km-btn-ghost"
            onClick={() => egressIp && copy(egressIp)}
          >
            复制 IP
          </button>
          <button
            type="button"
            className="km-btn km-btn-ghost"
            disabled={Boolean(busy)}
            onClick={() => void run("egress", loadEgress)}
          >
            {busy === "egress" ? "探测中…" : "重探测"}
          </button>
        </div>
      </div>

      <div className="km-panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">多卡台账户</h3>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/card-selection" className="km-btn km-btn-ghost">
              去选卡配置
            </Link>
            <button className="km-btn km-btn-ghost" onClick={() => setSelectedId("new")}>
              添加账户
            </button>
            <button
              className="km-btn km-btn-ghost"
              disabled={Boolean(busy)}
              onClick={() => void run("reload", async () => { await loadAccounts(); })}
            >
              刷新
            </button>
          </div>
        </div>
        <p className="text-sm text-[var(--km-fg-muted)]">
          Webhook 路径必须是{" "}
          <code>/api/v1/webhooks/cardplatform/账户ID</code>
          ，不要填到易支付回调。
        </p>
        <div className="flex flex-wrap gap-2">
          {accounts.map((account) => (
            <button
              key={account.id}
              className={`km-btn ${selectedId === account.id ? "" : "km-btn-ghost"}`}
              onClick={() => setSelectedId(account.id)}
            >
              {account.name}
              {account.isDefault ? " · 主" : " · 备"}
              {account.enabled ? "" : " · 已停用"}
            </button>
          ))}
        </div>
      </div>

      <div className="km-panel space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">
            {selectedId === "new" ? "新卡台账户" : selected?.name || "账户配置"}
          </h3>
          {selected ? (
            <span className={`km-badge ${selected.enabled ? "km-badge-ok" : "km-badge-wait"}`}>
              {selected.enabled ? "启用" : "停用"}
            </span>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span>名称</span>
            <input
              className="km-input"
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>协议</span>
            <select
              className="km-input"
              value={form.protocol}
              onChange={(e) => setForm((s) => ({ ...s, protocol: e.target.value }))}
            >
              <option value="spacexcard-legacy">SpaceX Legacy</option>
              <option value="avanfinity-2026-08">Avanfinity</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span>卡台地址</span>
            <input
              className="km-input"
              placeholder="https://zovocard.com"
              value={form.siteBase}
              onChange={(e) => setForm((s) => ({ ...s, siteBase: e.target.value }))}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>OpenAPI Key</span>
            <input
              className="km-input font-mono"
              type="password"
              placeholder={selected?.apiKeyConfigured ? "留空则不修改" : "sk_…"}
              value={form.apiKey}
              onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>优先级（数字越小越前）</span>
            <input
              className="km-input"
              type="number"
              min={1}
              max={999}
              value={form.priority}
              onChange={(e) =>
                setForm((s) => ({ ...s, priority: Number(e.target.value) || 100 }))
              }
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))}
            />
            启用
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm((s) => ({ ...s, isDefault: e.target.checked }))}
            />
            主台（默认发码）
          </label>
        </div>
        {selected?.lastError ? (
          <p className="text-xs text-[var(--km-fg-muted)]">
            上次探测未通过，点上面按钮看右上角通知。
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="km-btn"
            disabled={Boolean(busy)}
            onClick={() =>
              void run("save", async () => {
                const data = await readApiJson(
                  await fetch("/api/admin/cardplatform/accounts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      id: typeof selectedId === "number" ? selectedId : undefined,
                      ...form,
                      apiKey: form.apiKey || undefined,
                      webhookSecret: undefined,
                    }),
                  }),
                );
                const id = Number(data.account?.id);
                await loadAccounts(id);
                notice("卡台账户已保存");
              })
            }
          >
            {busy === "save" ? "保存中…" : "保存账户"}
          </button>
          {typeof selectedId === "number" ? (
            <>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("ping", async () => {
                    const data = await readApiJson(
                      await fetch(`/api/admin/cardplatform/accounts/${selectedId}/ping`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ mode: "all" }),
                      }),
                    );
                    notice(
                      `一键检测完成：套餐 ${data.plans ?? 0} 个，可消费 ${
                        data.spendableCents != null
                          ? (data.spendableCents / 100).toFixed(2)
                          : "—"
                      }`,
                    );
                    await loadAccounts(selectedId);
                  })
                }
              >
                {busy === "ping" ? "检测中…" : "一键检测"}
              </button>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("sync-plans", async () => {
                    const data = await readApiJson(
                      await fetch("/api/admin/cardplatform/sync-plans", {
                        method: "POST",
                      }),
                    );
                    notice(`已同步 ${data.count ?? 0} 个售卖套餐`);
                  })
                }
              >
                {busy === "sync-plans" ? "同步中…" : "同步售卖套餐"}
              </button>
              {(["connect", "price", "balance"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="km-btn km-btn-ghost"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(mode, async () => {
                      const data = await readApiJson(
                        await fetch(`/api/admin/cardplatform/accounts/${selectedId}/ping`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ mode }),
                        }),
                      );
                      notice(
                        mode === "balance"
                          ? `余额 ${
                              data.spendableCents != null
                                ? (data.spendableCents / 100).toFixed(2)
                                : "—"
                            }`
                          : mode === "price"
                            ? `价格/套餐 ${data.plans ?? 0} 个`
                            : data.connect?.message || "连通",
                      );
                      await loadAccounts(selectedId);
                    })
                  }
                >
                  {busy === mode
                    ? "请求中…"
                    : mode === "connect"
                      ? "连通"
                      : mode === "price"
                        ? "价格"
                        : "余额"}
                </button>
              ))}
            </>
          ) : null}
        </div>
        {typeof selectedId === "number" ? (
          <div className="space-y-3 border-t border-[var(--km-border)] pt-3">
            {/loca\.lt/i.test(form.webhookUrl) ? (
              <p className="text-sm text-[var(--km-danger)]">
                当前 Webhook 还是 loca.lt，隧道很容易断。请把下方「本站公网地址」改成
                trycloudflare 地址后再保存。
              </p>
            ) : null}
            <label className="block space-y-1 text-sm">
              <span>Webhook URL</span>
              <div className="flex flex-wrap gap-2">
                <input
                  className="km-input font-mono flex-1 min-w-[16rem]"
                  value={form.webhookUrl}
                  onChange={(e) => setForm((s) => ({ ...s, webhookUrl: e.target.value }))}
                />
                <button
                  className="km-btn km-btn-ghost"
                  onClick={() => copy(form.webhookUrl)}
                >
                  复制
                </button>
                <button
                  className="km-btn km-btn-ghost"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run("webhook-url", async () => {
                      await readApiJson(
                        await fetch(`/api/admin/cardplatform/accounts/${selectedId}/webhook`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ webhookUrl: form.webhookUrl }),
                        }),
                      );
                      await loadAccounts(selectedId);
                      notice("Webhook URL 已保存");
                    })
                  }
                >
                  保存 URL
                </button>
              </div>
            </label>
            <label className="block space-y-1 text-sm">
              <span>Webhook Secret</span>
              <div className="flex flex-wrap gap-2">
                <input
                  className="km-input font-mono flex-1 min-w-[16rem]"
                  type="password"
                  placeholder={
                    selected?.webhookSecretConfigured
                      ? `已配置 ${selected.webhookSecretHint}，留空不改`
                      : "粘贴该台开发者页的 whsec_…"
                  }
                  value={form.webhookSecret}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, webhookSecret: e.target.value }))
                  }
                />
                <button
                  className="km-btn km-btn-ghost"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run("webhook-secret", async () => {
                      if (!form.webhookSecret) throw new Error("请粘贴 Secret");
                      await readApiJson(
                        await fetch(`/api/admin/cardplatform/accounts/${selectedId}/webhook`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ webhookSecret: form.webhookSecret }),
                        }),
                      );
                      setForm((s) => ({ ...s, webhookSecret: "" }));
                      await loadAccounts(selectedId);
                      notice("Webhook Secret 已保存");
                    })
                  }
                >
                  保存该台 Secret
                </button>
              </div>
            </label>
            <div>
              <p className="mb-1 text-xs text-[var(--km-fg-muted)]">该台最近事件</p>
              {selectedEvents.length === 0 ? (
                <p className="text-sm text-[var(--km-fg-muted)]">暂无该台回调</p>
              ) : (
                selectedEvents.map((event) => (
                  <p key={event.id} className="font-mono text-xs text-[var(--km-fg-muted)]">
                    {formatWhen(event.createdAt)} · {event.eventType || "—"} ·{" "}
                    {summarizeEvent(event.payload)}
                  </p>
                ))
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-[var(--km-fg-muted)]">
            公网地址 {publicBaseUrl || "（先在下方保存本站公网地址）"}
            /api/v1/webhooks/cardplatform/账户ID
          </p>
        )}
      </div>

      <div className="km-panel space-y-2">
        <h3 className="font-semibold">选卡配置</h3>
        <p className="text-sm text-[var(--km-fg-muted)]">
          产品在线状态、自动选卡优先级、本站兑换策略和卡健康在独立页，和 danew 一样按账户分开配。
        </p>
        <Link href="/admin/card-selection" className="km-btn">
          打开选卡配置
        </Link>
      </div>
    </div>
  );
}
