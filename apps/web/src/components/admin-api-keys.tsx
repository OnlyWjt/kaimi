"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { formatDateTime } from "@/lib/datetime";

type KeyRow = {
  id: number;
  name: string;
  ownerType: string;
  agentId: number | null;
  keyPrefix: string;
  scopes: string;
  status: string;
  lastUsedAt: string | null;
};

const PLATFORM_SCOPES = [
  "plans:read",
  "orders:read",
  "orders:write",
  "cdks:read",
  "cdks:reveal",
  "redeem:write",
  "redeem:read",
  "earnings:read",
  "agents:read",
];

export function AdminApiKeys() {
  const [list, setList] = useState<KeyRow[]>([]);
  const [name, setName] = useState("平台 Key");
  const [picked, setPicked] = useState<string[]>(["plans:read", "orders:read"]);
  const [token, setToken] = useState("");

  async function reload() {
    const response = await fetch("/api/admin/api-keys");
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "加载失败", "err");
      return;
    }
    setList(data.list || []);
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="space-y-4">
      <section className="km-panel space-y-3">
        <h2 className="text-xl font-semibold">新建平台 Key</h2>
        <input className="km-input max-w-xs" value={name} onChange={(event) => setName(event.target.value)} />
        <div className="flex flex-wrap gap-3 text-sm">
          {PLATFORM_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={picked.includes(scope)}
                onChange={(event) =>
                  setPicked((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((item) => item !== scope),
                  )
                }
              />
              {scope}
            </label>
          ))}
        </div>
        <button
          className="km-btn"
          onClick={async () => {
            const response = await fetch("/api/admin/api-keys", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, ownerType: "platform", scopes: picked }),
            });
            const data = await response.json();
            if (!response.ok) {
              toast(data.error || "创建失败", "err");
              return;
            }
            setToken(data.token || "");
            toast("Key 已创建，明文只显示这一次");
            await reload();
          }}
        >
          创建
        </button>
        {token ? <pre className="overflow-x-auto rounded bg-[var(--km-bg)] p-3 text-sm">{token}</pre> : null}
      </section>
      <section className="km-panel overflow-x-auto">
        <h2 className="mb-3 text-xl font-semibold">全部 Key</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]">
              <th className="py-2 pr-3">名称</th>
              <th className="py-2 pr-3">归属</th>
              <th className="py-2 pr-3">前缀</th>
              <th className="py-2 pr-3">状态</th>
              <th className="py-2 pr-3">最近使用</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.id} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">{row.name}</td>
                <td className="py-2 pr-3">
                  {row.ownerType === "agent" ? `代理 ${row.agentId}` : "平台"}
                </td>
                <td className="py-2 pr-3 font-mono">{row.keyPrefix}</td>
                <td className="py-2 pr-3">{row.status === "active" ? "有效" : "已吊销"}</td>
                <td className="py-2 pr-3">{formatDateTime(row.lastUsedAt)}</td>
                <td className="py-2">
                  {row.status === "active" ? (
                    <button
                      className="km-btn km-btn-ghost"
                      onClick={async () => {
                        await fetch(`/api/admin/api-keys?id=${row.id}`, { method: "DELETE" });
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
    </div>
  );
}
