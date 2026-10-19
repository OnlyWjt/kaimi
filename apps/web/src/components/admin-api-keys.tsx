"use client";

import { useEffect, useState } from "react";
import { AllowlistInput, parseList, ScopeList, ScopePicker, splitIps } from "@/components/agent-api-keys";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { formatDateTime } from "@/lib/datetime";
import { AGENT_SCOPES, isTestKeyGrantableScope } from "@/lib/open-api/scopes";
import "./agent-console.css";

type KeyRow = {
  id: number;
  name: string;
  ownerType: string;
  agentId: number | null;
  keyPrefix: string;
  scopes: string;
  ipAllowlist: string;
  mode: string;
  status: string;
  lastUsedAt: string | null;
  lastUsedIp: string;
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

/** 编辑时能勾的权限：平台 Key 用平台那套，代理 Key 按代理范围，测试 Key 再收窄。 */
function editableScopes(row: KeyRow) {
  if (row.ownerType !== "agent") return PLATFORM_SCOPES;
  const scopes: string[] = [...AGENT_SCOPES];
  return row.mode === "test" ? scopes.filter(isTestKeyGrantableScope) : scopes;
}

export function AdminApiKeys() {
  const { ask, dialog } = useAskDialog();
  const [list, setList] = useState<KeyRow[]>([]);
  const [name, setName] = useState("平台 Key");
  const [picked, setPicked] = useState<string[]>(["plans:read", "orders:read"]);
  const [ips, setIps] = useState("");
  const [token, setToken] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  async function reload() {
    const response = await fetch("/api/admin/api-keys");
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "加载失败", "err");
      return;
    }
    const rows: KeyRow[] = data.list || [];
    setList([...rows.filter((row) => row.status === "active"), ...rows.filter((row) => row.status !== "active")]);
  }

  useEffect(() => {
    void reload();
  }, []);

  async function revoke(row: KeyRow) {
    const answer = await ask({
      title: `吊销「${row.name}」？`,
      message: "吊销后，用这把 Key 的调用会立刻失败，不能恢复。",
      confirmLabel: "吊销",
      danger: true,
    });
    if (!answer) return;
    const response = await fetch(`/api/admin/api-keys?id=${row.id}`, { method: "DELETE" });
    if (!response.ok) {
      toast("吊销失败", "err");
      return;
    }
    if (editingId === row.id) setEditingId(null);
    await reload();
  }

  return (
    <div className="space-y-4">
      <section className="km-panel space-y-3">
        <h2 className="text-xl font-semibold">新建平台 Key</h2>
        <div className="km-api-create">
          <label className="km-api-field">
            <span className="km-api-label">名称</span>
            <input className="km-input max-w-xs" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="km-api-field">
            <span className="km-api-label">权限</span>
            <ScopePicker scopes={PLATFORM_SCOPES} picked={picked} onChange={setPicked} />
          </div>
          <AllowlistInput value={ips} onChange={setIps} required />
          <div>
            <button
              className="km-btn"
              disabled={!picked.length || !name.trim()}
              onClick={async () => {
                const response = await fetch("/api/admin/api-keys", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name, ownerType: "platform", scopes: picked, ipAllowlist: splitIps(ips) }),
                });
                const data = await response.json();
                if (!response.ok) {
                  toast(data.error || "创建失败", "err");
                  return;
                }
                setToken(data.token || "");
                setIps("");
                toast("Key 已创建，明文只显示这一次");
                await reload();
              }}
            >
              创建
            </button>
          </div>
        </div>
        {token ? <pre className="overflow-x-auto rounded bg-[var(--km-bg)] p-3 text-sm">{token}</pre> : null}
      </section>
      <section className="km-panel">
        <h2 className="mb-3 text-xl font-semibold">全部 Key</h2>
        <div className="overflow-x-auto">
          <table className="km-acp-orders km-api-keys">
            <thead>
              <tr>
                <th>名称</th>
                <th>归属</th>
                <th>权限</th>
                <th>IP 白名单</th>
                <th>最近使用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.flatMap((row) => {
                const active = row.status === "active";
                const allowlist = parseList(row.ipAllowlist);
                const editing = editingId === row.id;
                const rows = [
                  <tr key={row.id} className={active ? (editing ? "is-editing" : undefined) : "is-muted"}>
                    <td>
                      <span className="km-api-name">
                        {row.name}
                        {row.mode === "test" ? <span className="km-acp-pill warn">测试</span> : null}
                        {!active ? <span className="km-acp-pill mute">已吊销</span> : null}
                      </span>
                      <span className="no sub">{row.keyPrefix}…</span>
                    </td>
                    <td className="whitespace-nowrap" data-label="归属">{row.ownerType === "agent" ? `代理 ${row.agentId}` : "平台"}</td>
                    <td className="km-api-scope-cell" data-label="权限">
                      <ScopeList scopes={parseList(row.scopes)} />
                    </td>
                    <td data-label="IP 白名单">
                      {allowlist.length ? (
                        <span className="km-api-ip-list">
                          {allowlist.map((ip) => (
                            <code key={ip}>{ip}</code>
                          ))}
                        </span>
                      ) : !active ? (
                        <span className="text-[var(--km-fg-muted)]">—</span>
                      ) : row.mode === "test" ? (
                        <span className="km-acp-pill mute">不限</span>
                      ) : (
                        <span className="km-acp-pill bad">未设置</span>
                      )}
                    </td>
                    <td data-label="最近使用">
                      {row.lastUsedAt ? (
                        <>
                          <span className="whitespace-nowrap">{formatDateTime(row.lastUsedAt)}</span>
                          {row.lastUsedIp ? <span className="sub">来自 {row.lastUsedIp}</span> : null}
                        </>
                      ) : (
                        <span className="text-[var(--km-fg-muted)]">没用过</span>
                      )}
                    </td>
                    <td className="act">
                      {active ? (
                        <>
                          <button
                            type="button"
                            className="km-acp-link"
                            onClick={() => setEditingId(editing ? null : row.id)}
                          >
                            {editing ? "收起" : "编辑"}
                          </button>
                          <button type="button" className="km-acp-link km-api-danger" onClick={() => revoke(row)}>
                            吊销
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>,
                ];
                if (editing) {
                  rows.push(
                    <tr key={`${row.id}-edit`} className="km-api-edit-row">
                      <td colSpan={6}>
                        <AdminKeyEditor
                          row={row}
                          onDone={async (saved) => {
                            setEditingId(null);
                            if (saved) await reload();
                          }}
                        />
                      </td>
                    </tr>,
                  );
                }
                return rows;
              })}
            </tbody>
          </table>
        </div>
      </section>
      {dialog}
    </div>
  );
}

function AdminKeyEditor({ row, onDone }: { row: KeyRow; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(row.name);
  const [picked, setPicked] = useState(() => parseList(row.scopes));
  const [ips, setIps] = useState(() => parseList(row.ipAllowlist).join("\n"));
  const [saving, setSaving] = useState(false);
  const scopes = editableScopes(row);
  const shown = [...scopes, ...picked.filter((scope) => !scopes.includes(scope))];

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/api-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, name, scopes: picked, ipAllowlist: splitIps(ips) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(data.error || "保存失败", "err");
        return;
      }
      toast("已保存，马上生效");
      onDone(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="km-api-editor">
      <label className="km-api-field">
        <span className="km-api-label">名称</span>
        <input className="km-input" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="km-api-field">
        <span className="km-api-label">权限</span>
        <ScopePicker scopes={shown} picked={picked} onChange={setPicked} />
      </div>
      <AllowlistInput value={ips} onChange={setIps} required={row.mode !== "test"} suggestIp={row.lastUsedIp} />
      <div className="flex flex-wrap gap-2">
        <button className="km-btn" disabled={saving || !picked.length || !name.trim()} onClick={save}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button className="km-btn km-btn-ghost" disabled={saving} onClick={() => onDone(false)}>
          取消
        </button>
      </div>
    </div>
  );
}
