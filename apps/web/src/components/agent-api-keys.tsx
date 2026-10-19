"use client";

import { useEffect, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { formatDateTime } from "@/lib/datetime";
import { ALLOWLIST_ENFORCED_FROM, ALLOWLIST_ENFORCED_LABEL, MAX_ALLOWLIST_ENTRIES } from "@/lib/open-api/key-policy";
import { isTestKeyGrantableScope, SCOPE_LABEL, TEST_KEY_GRANTABLE_SCOPES } from "@/lib/open-api/scopes";

type KeyRow = {
  id: number;
  name: string;
  keyPrefix: string;
  scopes: string;
  ipAllowlist: string;
  status: string;
  lastUsedAt: string | null;
  lastUsedIp: string;
  createdAt: string;
  mode?: string;
};

/** 新建正式 Key 默认勾的权限：查询类加上兑换，够对接一个分销站用。 */
const DEFAULT_LIVE_SCOPES = ["plans:read", "orders:read", "cdks:read", "redeem:write", "redeem:read"];

export function parseList(raw: string) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/** 白名单输入框：换行、空格、逗号分隔都认。 */
export function splitIps(text: string) {
  return text
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 列表里的权限：按名字折行，别把「看卡密明文」从中间劈开。 */
export function ScopeList({ scopes }: { scopes: readonly string[] }) {
  return (
    <>
      {scopes.map((scope, index) => (
        <span key={scope} className="km-api-scope">
          {SCOPE_LABEL[scope] || scope}
          {index < scopes.length - 1 ? "、" : ""}
        </span>
      ))}
    </>
  );
}

export function ScopePicker({
  scopes,
  picked,
  onChange,
}: {
  scopes: readonly string[];
  picked: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="km-api-scopes">
      {scopes.map((scope) => (
        <label key={scope}>
          <input
            type="checkbox"
            checked={picked.includes(scope)}
            onChange={(event) =>
              onChange(event.target.checked ? [...picked, scope] : picked.filter((item) => item !== scope))
            }
          />
          {SCOPE_LABEL[scope] || scope}
        </label>
      ))}
    </div>
  );
}

export function AllowlistInput({
  value,
  onChange,
  required,
  suggestIp,
}: {
  value: string;
  onChange: (next: string) => void;
  required: boolean;
  suggestIp?: string;
}) {
  const canSuggest = !!suggestIp && suggestIp !== "local" && !splitIps(value).includes(suggestIp);
  return (
    <div className="km-api-field">
      <span className="km-api-label">
        IP 白名单<em>{required ? "必填" : "选填"}</em>
      </span>
      <textarea
        className="km-input km-api-ips"
        rows={3}
        spellCheck={false}
        placeholder={"203.0.113.10\n198.51.100.0/24"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="km-api-hint">
        只有这些 IP 能用这把 Key。一行一个，最多 {MAX_ALLOWLIST_ENTRIES} 条，也可以填网段（IPv4 最宽 /24）。
        {canSuggest ? (
          <>
            {" "}最近一次调用来自 <code>{suggestIp}</code>，
            <button
              type="button"
              className="km-acp-link"
              onClick={() => onChange([...splitIps(value), suggestIp!].join("\n"))}
            >
              加进去
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function AgentApiKeys() {
  const { ask, dialog } = useAskDialog();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [name, setName] = useState("默认 Key");
  const [picked, setPicked] = useState<string[]>(DEFAULT_LIVE_SCOPES);
  const [ips, setIps] = useState("");
  const [testMode, setTestMode] = useState(false);
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const visibleScopes = testMode ? scopes.filter(isTestKeyGrantableScope) : scopes;

  async function reload() {
    const response = await fetch("/api/agent/api-keys");
    const data = await response.json();
    // 有效的排前面，吊销的沉到底下
    const list: KeyRow[] = data.list || [];
    setKeys([...list.filter((row) => row.status === "active"), ...list.filter((row) => row.status !== "active")]);
    setScopes(data.scopes || []);
  }

  useEffect(() => {
    void reload();
  }, []);

  async function create() {
    setCreating(true);
    try {
      const response = await fetch("/api/agent/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scopes: testMode ? picked.filter(isTestKeyGrantableScope) : picked,
          mode: testMode ? "test" : "live",
          ipAllowlist: splitIps(ips),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast(data.error || "创建失败", "err");
        return;
      }
      setFreshToken(data.token || "");
      setIps("");
      toast("Key 已创建，请马上复制");
      await reload();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(row: KeyRow) {
    const answer = await ask({
      title: `吊销「${row.name}」？`,
      message: "吊销后，用这把 Key 的调用会立刻失败，不能恢复。只是想改权限或白名单的话，点「编辑」就行。",
      confirmLabel: "吊销",
      danger: true,
    });
    if (!answer) return;
    const response = await fetch(`/api/agent/api-keys?id=${row.id}`, { method: "DELETE" });
    if (!response.ok) {
      toast("吊销失败", "err");
      return;
    }
    if (editingId === row.id) setEditingId(null);
    toast("已吊销");
    await reload();
  }

  const unguarded = keys.filter(
    (row) => row.status === "active" && row.mode !== "test" && !parseList(row.ipAllowlist).length,
  );
  const enforced = new Date().toISOString() >= ALLOWLIST_ENFORCED_FROM;

  return (
    <section className="km-panel space-y-4">
      <div className="space-y-2">
        <h2 className="font-semibold">API Key</h2>
        <p className="text-sm text-[var(--km-fg-muted)]">
          请求头带 Authorization: Bearer km_live_... 。明文只在创建时出现一次。代理 Key 只能访问自己店铺的数据，也只能兑换自己卖出的卡。正式 Key 必须设 IP 白名单；权限和白名单建好后随时能改，改完马上生效。
        </p>
        <p className="text-sm text-[var(--km-fg-muted)]">
          对接自己的分销站时，先建一把<strong>测试 Key</strong>（km_test_ 开头）：下单返回的付款链接打开就算付款成功，发的是 TEST- 开头的假卡，回调里 livemode 为 false，不扣钱、不进账本。跑通后再换正式 Key。
        </p>
      </div>

      {unguarded.length ? (
        <div className="km-acp-warn">
          {unguarded.map((row) => `「${row.name}」`).join("")}还没设 IP 白名单。
          {enforced
            ? "现在用它调用会被拒绝，"
            : `${ALLOWLIST_ENFORCED_LABEL}起没设白名单的正式 Key 会被拒绝调用，`}
          请点「编辑」填上调用方服务器的 IP。
        </div>
      ) : null}

      <div className="km-api-create">
        <div className="km-api-create-head">
          <label className="km-api-field">
            <span className="km-api-label">名称</span>
            <input className="km-input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="km-api-mode">
            <input
              type="checkbox"
              checked={testMode}
              onChange={(event) => {
                setTestMode(event.target.checked);
                setPicked(event.target.checked ? [...TEST_KEY_GRANTABLE_SCOPES] : DEFAULT_LIVE_SCOPES);
              }}
            />
            测试 Key（沙箱，不产生真实订单）
          </label>
        </div>
        <div className="km-api-field">
          <span className="km-api-label">权限</span>
          <ScopePicker scopes={visibleScopes} picked={picked} onChange={setPicked} />
        </div>
        <AllowlistInput value={ips} onChange={setIps} required={!testMode} />
        <div>
          <button className="km-btn km-btn-sm" disabled={creating || !picked.length || !name.trim()} onClick={create}>
            {creating ? "创建中…" : "创建 Key"}
          </button>
        </div>
      </div>

      {freshToken ? (
        <div className="km-api-token">
          <p>
            <strong>新 Key 只显示这一次</strong>，请马上复制，放到服务器配置里，别贴到聊天里。
          </p>
          <div className="km-api-token-row">
            <code>{freshToken}</code>
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(freshToken);
                  toast("已复制");
                } catch {
                  toast("复制失败，请手动选中复制", "err");
                }
              }}
            >
              复制
            </button>
          </div>
        </div>
      ) : null}

      {keys.length ? (
        <div className="overflow-x-auto">
          <table className="km-acp-orders km-api-keys">
            <thead>
              <tr>
                <th>名称</th>
                <th>权限</th>
                <th>IP 白名单</th>
                <th>最近使用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.flatMap((row) => {
                const active = row.status === "active";
                const allowlist = parseList(row.ipAllowlist);
                const rowScopes = parseList(row.scopes);
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
                    <td className="km-api-scope-cell" data-label="权限">
                      <ScopeList scopes={rowScopes} />
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
                      <td colSpan={5}>
                        <KeyEditor
                          row={row}
                          scopes={row.mode === "test" ? scopes.filter(isTestKeyGrantableScope) : scopes}
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
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">还没有 Key。</p>
      )}
      {dialog}
    </section>
  );
}

function KeyEditor({
  row,
  scopes,
  onDone,
}: {
  row: KeyRow;
  scopes: string[];
  onDone: (saved: boolean) => void;
}) {
  const [name, setName] = useState(row.name);
  const [picked, setPicked] = useState(() => parseList(row.scopes));
  const [ips, setIps] = useState(() => parseList(row.ipAllowlist).join("\n"));
  const [saving, setSaving] = useState(false);
  // 已经有、但现在不给勾的权限（比如提卡被收回）也要列出来，不然一保存就悄悄丢了。
  const shown = [...scopes, ...picked.filter((scope) => !scopes.includes(scope))];

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/agent/api-keys", {
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
        <button className="km-btn km-btn-sm" disabled={saving || !picked.length || !name.trim()} onClick={save}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button className="km-btn km-btn-ghost km-btn-sm" disabled={saving} onClick={() => onDone(false)}>
          取消
        </button>
      </div>
    </div>
  );
}
