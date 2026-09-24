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
};

const SCOPE_LABEL: Record<string, string> = {
  "plans:read": "查套餐",
  "orders:read": "查订单",
  "cdks:read": "查卡密",
  "cdks:reveal": "看卡密明文",
  "redeem:write": "提交兑换",
  "redeem:read": "查兑换结果",
};

export function AgentApiPanel() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [name, setName] = useState("默认 Key");
  const [picked, setPicked] = useState<string[]>(["plans:read", "orders:read", "cdks:read", "redeem:read"]);
  const [freshToken, setFreshToken] = useState("");

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
    <div className="space-y-6">
      <section className="km-panel space-y-3">
        <h2 className="font-semibold">API Key</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          请求头带 Authorization: Bearer km_live_... 。明文只在创建时出现一次。代理 Key 只能访问自己店铺的数据，也只能兑换自己卖出的卡。
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
                body: JSON.stringify({ name, scopes: picked }),
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
        <div className="flex flex-wrap gap-3 text-sm">
          {scopes.map((scope) => (
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
                <td className="py-2">{row.name}</td>
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

      <WebhookForm />
      <AgentApiDocs />
    </div>
  );
}

function WebhookForm() {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [list, setList] = useState<Array<{ id: number; url: string; status: string }>>([]);

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
      <h2 className="font-semibold">兑换结果回调</h2>
      <p>
        这里填<strong>你自己服务器</strong>上能接收 POST 的 https 地址，例如
        <code> https://api.example.com/hooks/kaimi</code>。不要填店铺链接，也不要填本站地址。
        兑换成功或失败后，本站会主动把结果 POST 到这个地址。
      </p>
      <ul className="list-disc space-y-1 pl-5 text-[var(--km-fg-muted)]">
        <li>请在 10 秒内返回任意 2xx，否则算失败。</li>
        <li>请求头 X-Kaimi-Event 是 redemption.succeeded 或 redemption.failed。</li>
        <li>请求头 X-Kaimi-Signature 是 t=时间戳,v1=HMAC。用保存时给你的密钥，对「时间戳.原始请求体」做 SHA256。请用原始 body 验签，时间戳超过 5 分钟应拒绝。</li>
        <li>失败后会在 1 分钟、5 分钟、30 分钟、2 小时、12 小时重试，共 5 次。同一笔单可能推送多次，用 redemption_no 去重。</li>
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
      <div className="flex flex-wrap gap-2">
        <button
          className="km-btn"
          onClick={async () => {
            const response = await fetch("/api/agent/webhooks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url,
                events: ["redemption.succeeded", "redemption.failed"],
              }),
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
          <span>{row.url}（{row.status === "active" ? "启用" : "已停用"}）</span>
          {row.status === "active" ? (
            <button
              className="km-btn km-btn-ghost"
              onClick={async () => {
                await fetch(`/api/agent/webhooks?id=${row.id}`, { method: "DELETE" });
                await reload();
              }}
            >
              停用
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
