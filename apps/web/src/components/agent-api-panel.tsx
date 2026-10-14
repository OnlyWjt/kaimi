"use client";

import { useEffect, useState } from "react";
import { AgentApiDocs } from "@/components/agent-api-docs";
import { toast } from "@/components/toast";
import { formatDateTime } from "@/lib/datetime";

type KeyRow = {
  id: number;
  name: string;
  keyPrefix: string;
  scopes: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
  mode?: string;
};

/** 测试 Key 能勾的权限，和服务端 TEST_KEY_SCOPES 一致。 */
const TEST_KEY_SCOPES = ["plans:read", "orders:read", "orders:write", "cdks:reveal"];

const SCOPE_LABEL: Record<string, string> = {
  "plans:read": "查套餐",
  "orders:read": "查订单",
  "orders:write": "代客下单支付",
  "cdks:read": "查卡密",
  "cdks:reveal": "看卡密明文",
  "redeem:write": "提交兑换",
  "redeem:read": "查兑换结果",
  "draw:read": "查提卡",
  "draw:write": "提卡",
  "draw:reveal": "看提卡明文",
};

const API_TABS = [
  { id: "keys", label: "API Key" },
  { id: "hooks", label: "事件回调" },
  { id: "docs", label: "接口文档" },
] as const;
type ApiTab = (typeof API_TABS)[number]["id"];

export function AgentApiPanel() {
  const [tab, setTab] = useState<ApiTab>("keys");
  useEffect(() => {
    const fromHash = window.location.hash.replace("#", "");
    if (API_TABS.some((item) => item.id === fromHash)) setTab(fromHash as ApiTab);
  }, []);
  function chooseTab(next: ApiTab) {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
  }
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [name, setName] = useState("默认 Key");
  const [picked, setPicked] = useState<string[]>(["plans:read", "orders:read", "cdks:read", "redeem:read"]);
  const [freshToken, setFreshToken] = useState("");
  const [testMode, setTestMode] = useState(false);
  const visibleScopes = testMode ? scopes.filter((scope) => TEST_KEY_SCOPES.includes(scope)) : scopes;

  async function reload() {
    const response = await fetch("/api/agent/api-keys");
    const data = await response.json();
    setKeys(data.list || []);
    setScopes(data.scopes || []);
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="space-y-5">
      <div className="km-acp-chips" role="tablist" aria-label="开放 API">
        {API_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`km-acp-chip km-api-tab${tab === item.id ? " is-on" : ""}`}
            onClick={() => chooseTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "keys" ? (
      <section className="km-panel space-y-3">
        <h2 className="font-semibold">API Key</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          请求头带 Authorization: Bearer km_live_... 。明文只在创建时出现一次。代理 Key 只能访问自己店铺的数据，也只能兑换自己卖出的卡。
        </p>
        <p className="text-sm text-[var(--km-fg-muted)]">
          对接自己的分销站时，先建一把<strong>测试 Key</strong>（km_test_ 开头）：下单返回的付款链接打开就算付款成功，发的是 TEST- 开头的假卡，回调里 livemode 为 false，不扣钱、不进账本。跑通后再换正式 Key。
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            名称
            <input className="km-input mt-1" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button
            className="km-btn"
            onClick={async () => {
              const response = await fetch("/api/agent/api-keys", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name,
                  scopes: testMode ? picked.filter((scope) => TEST_KEY_SCOPES.includes(scope)) : picked,
                  mode: testMode ? "test" : "live",
                }),
              });
              const data = await response.json();
              if (!response.ok) {
                toast(data.error || "创建失败");
                return;
              }
              setFreshToken(data.token || "");
              toast("Key 已创建，请马上复制");
              await reload();
            }}
          >
            创建
          </button>
        </div>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={testMode}
            onChange={(event) => {
              setTestMode(event.target.checked);
              if (event.target.checked) setPicked(["plans:read", "orders:read", "orders:write", "cdks:reveal"]);
            }}
          />
          测试 Key（沙箱，不产生真实订单）
        </label>
        <div className="flex flex-wrap gap-3 text-sm">
          {visibleScopes.map((scope) => (
            <label key={scope} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={picked.includes(scope)}
                onChange={(event) => {
                  setPicked((current) =>
                    event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                  );
                }}
              />
              {SCOPE_LABEL[scope] || scope}
            </label>
          ))}
        </div>
        {freshToken ? (
          <pre className="overflow-x-auto rounded bg-[var(--km-bg)] p-3 text-sm">{freshToken}</pre>
        ) : null}
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-2">名称</th>
              <th>前缀</th>
              <th>状态</th>
              <th>最近使用</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((row) => (
              <tr key={row.id} className="border-t border-[var(--km-border)]">
                <td className="py-2">
                  {row.name}
                  {row.mode === "test" ? <span className="km-acp-pill warn ml-2">测试</span> : null}
                </td>
                <td className="font-mono">{row.keyPrefix}</td>
                <td>{row.status === "active" ? "有效" : "已吊销"}</td>
                <td>{formatDateTime(row.lastUsedAt)}</td>
                <td>
                  {row.status === "active" ? (
                    <button
                      className="km-btn km-btn-ghost"
                      onClick={async () => {
                        await fetch(`/api/agent/api-keys?id=${row.id}`, { method: "DELETE" });
                        await reload();
                      }}
                    >
                      吊销
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      ) : null}
      {tab === "hooks" ? <WebhookForm /> : null}
      {tab === "docs" ? <AgentApiDocs /> : null}
    </div>
  );
}

const WEBHOOK_EVENT_OPTIONS = [
  { value: "order.paid", label: "订单已付款" },
  { value: "order.delivered", label: "订单已发货" },
  { value: "redemption.succeeded", label: "兑换成功" },
  { value: "redemption.failed", label: "兑换失败" },
] as const;

function parseEventList(raw: string) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function WebhookForm() {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(WEBHOOK_EVENT_OPTIONS.map((item) => item.value));
  const [list, setList] = useState<Array<{ id: number; url: string; status: string; events: string }>>([]);
  const [deliveryReload, setDeliveryReload] = useState(0);

  async function reload() {
    const response = await fetch("/api/agent/webhooks");
    const data = await response.json();
    setList(data.list || []);
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <section className="km-panel space-y-3 text-sm">
      <h2 className="font-semibold">事件回调</h2>
      <p>
        这里填<strong>你自己服务器</strong>上能接收 POST 的 https 地址，例如
        <code> https://api.example.com/hooks/kaimi</code>。不要填店铺链接，也不要填本站地址。
        订单付款、发货，或兑换成功、失败后，本站会主动把结果 POST 到这个地址。
      </p>
      <ul className="list-disc space-y-1 pl-5 text-[var(--km-fg-muted)]">
        <li>请在 10 秒内返回任意 2xx，否则算失败。</li>
        <li>请求头 X-Kaimi-Event 是事件名：order.paid、order.delivered、redemption.succeeded 或 redemption.failed。</li>
        <li>请求头 X-Kaimi-Signature 是 t=时间戳,v1=HMAC。用保存时给你的密钥，对「时间戳.原始请求体」做 SHA256。请用原始 body 验签，时间戳超过 5 分钟应拒绝。</li>
        <li>失败后会在 1 分钟、5 分钟、30 分钟、2 小时、12 小时重试，共 5 次。同一事件可能推送多次，订单用 order_no + event 去重，兑换用 redemption_no 去重。</li>
        <li>订单回调里不带卡密，收到后用 GET /orders/{"{orderNo}"} 取。</li>
      </ul>
      <label className="block space-y-1">
        <span>你的接收地址</span>
        <input
          className="km-input max-w-xl"
          placeholder="https://api.example.com/hooks/kaimi"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <fieldset className="space-y-1">
        <legend>推送哪些事件</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {WEBHOOK_EVENT_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={events.includes(option.value)}
                onChange={(event) =>
                  setEvents((current) =>
                    event.target.checked
                      ? [...current, option.value]
                      : current.filter((item) => item !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button
          className="km-btn"
          disabled={!events.length}
          onClick={async () => {
            const response = await fetch("/api/agent/webhooks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url, events }),
            });
            const data = await response.json();
            if (!response.ok) {
              toast(data.error || "保存失败", "err");
              return;
            }
            setSecret(data.secret || "");
            toast("回调已保存，密钥只显示这一次");
            await reload();
          }}
        >
          保存
        </button>
      </div>
      {secret ? <pre className="overflow-x-auto rounded bg-[var(--km-bg)] p-3">{secret}</pre> : null}
      {list.map((row) => (
        <div key={row.id} className="flex items-center justify-between gap-2">
          <span>
            {row.url}（{row.status === "active" ? "启用" : "已停用"}）
            <span className="ml-2 text-[var(--km-fg-muted)]">
              {parseEventList(row.events)
                .map((value) => WEBHOOK_EVENT_OPTIONS.find((item) => item.value === value)?.label || value)
                .join("、")}
            </span>
          </span>
          {row.status === "active" ? (
            <span className="flex gap-2">
              <button
                className="km-btn km-btn-ghost"
                onClick={async () => {
                  const response = await fetch("/api/agent/webhooks/test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ endpointId: row.id }),
                  });
                  const data = await response.json().catch(() => ({}));
                  if (!response.ok) {
                    toast(data.error || "发送失败", "err");
                    return;
                  }
                  toast("测试推送已发出，几秒后在下方记录里看结果");
                  setTimeout(() => setDeliveryReload((n) => n + 1), 3000);
                }}
              >
                发送测试
              </button>
              <button
                className="km-btn km-btn-ghost"
                onClick={async () => {
                  await fetch(`/api/agent/webhooks?id=${row.id}`, { method: "DELETE" });
                  await reload();
                }}
              >
                停用
              </button>
            </span>
          ) : null}
        </div>
      ))}
      {list.length ? <WebhookDeliveries reloadKey={deliveryReload} /> : null}
    </section>
  );
}

type DeliveryRow = {
  id: number;
  url: string;
  event: string;
  attempt: number;
  lastStatus: number | null;
  lastError: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  payload: string;
};

function deliveryState(row: DeliveryRow) {
  if (row.deliveredAt) return { text: `成功 ${row.lastStatus ?? ""}`.trim(), tone: "" };
  if (row.attempt === 0) return { text: "排队中", tone: " mute" };
  if (row.nextAttemptAt) return { text: `失败，${formatDateTime(row.nextAttemptAt)} 重试`, tone: " warn" };
  return { text: "失败，不再重试", tone: " bad" };
}

/** 最近 50 条投递：发没发、对方回了什么，失败的可以手动重发。 */
function WebhookDeliveries({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/agent/webhooks/deliveries", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!cancelled) setRows(data.list || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, tick]);

  return (
    <div className="space-y-2 border-t border-[var(--km-border)] pt-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">最近投递</h3>
        <button className="km-btn km-btn-ghost" onClick={() => setTick((n) => n + 1)}>
          刷新
        </button>
      </div>
      {!rows.length ? <p className="text-[var(--km-fg-muted)]">还没有投递记录。点上面的「发送测试」试一下。</p> : null}
      <div className="overflow-x-auto">
        <table className="km-acp-price">
          <tbody>
            {rows.map((row) => {
              const state = deliveryState(row);
              return (
                <tr key={row.id}>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(row.createdAt)}</td>
                  <td className="font-mono text-xs">{row.event}</td>
                  <td>
                    <span className={`km-acp-pill${state.tone}`}>{state.text}</span>
                    {row.lastError ? (
                      <p className="mt-1 text-xs text-[var(--km-fg-muted)]">{row.lastError}</p>
                    ) : null}
                    {open === row.id ? (
                      <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-[var(--km-bg)] p-2 text-xs">{row.payload}</pre>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap">
                    <button className="km-btn km-btn-ghost" onClick={() => setOpen(open === row.id ? null : row.id)}>
                      {open === row.id ? "收起" : "看内容"}
                    </button>
                    <button
                      className="km-btn km-btn-ghost"
                      onClick={async () => {
                        const response = await fetch(`/api/agent/webhooks/deliveries/${row.id}/redeliver`, {
                          method: "POST",
                        });
                        const data = await response.json().catch(() => ({}));
                        if (!response.ok) {
                          toast(data.error || "重发失败", "err");
                          return;
                        }
                        toast("已重新发出");
                        setTimeout(() => setTick((n) => n + 1), 3000);
                      }}
                    >
                      重发
                    </button>
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
