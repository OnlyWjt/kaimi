"use client";

import { useEffect, useState } from "react";
import { AgentApiDocs } from "@/components/agent-api-docs";
import { AgentApiKeys } from "@/components/agent-api-keys";
import { toast } from "@/components/toast";
import { formatDateTime } from "@/lib/datetime";

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
      {tab === "keys" ? <AgentApiKeys /> : null}
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
