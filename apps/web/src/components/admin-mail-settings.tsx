"use client";

import { useEffect, useState } from "react";

type MailForm = {
  enabled: boolean;
  orderEnabled: boolean;
  starttls: boolean;
  ssl: boolean;
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
  fromName: string;
  passwordConfigured: boolean;
};

const EMPTY: MailForm = {
  enabled: false,
  orderEnabled: false,
  starttls: false,
  ssl: true,
  host: "",
  port: "465",
  user: "",
  password: "",
  from: "",
  fromName: "",
  passwordConfigured: false,
};

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="flex items-center gap-2 text-sm"
      onClick={() => onChange(!checked)}
    >
      <span className={`relative h-6 w-11 rounded-full ${checked ? "bg-[var(--km-fg)]" : "bg-[var(--km-border)]"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${checked ? "left-5" : "left-0.5"}`} />
      </span>
      {label}
    </button>
  );
}

export function AdminMailSettings() {
  const [form, setForm] = useState(EMPTY);
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/mail", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!data || data.error) return;
        setForm((current) => ({ ...current, ...data, password: "" }));
      })
      .catch(() => undefined);
  }, []);

  function patch(partial: Partial<MailForm>) {
    setForm((current) => ({ ...current, ...partial }));
  }

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setMessage("邮件配置已保存");
      patch({ password: "", passwordConfigured: form.passwordConfigured || Boolean(form.password) });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function testSend() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", to }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "发送失败");
      setMessage(`测试邮件已发到 ${to}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="km-panel space-y-4">
      <div>
        <h2 className="text-xl font-semibold">邮件通知</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          平台统一发信。发件邮箱必须是这台 SMTP 验证过的地址。发件人名称是代理没单独设置时的默认显示名。密码留空表示不修改。
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Switch checked={form.enabled} onChange={(enabled) => patch({ enabled })} label="启用邮件发送" />
        <Switch checked={form.orderEnabled} onChange={(orderEnabled) => patch({ orderEnabled })} label="启用订单邮件通知" />
      </div>
      <div className="flex flex-wrap gap-6">
        <Switch checked={form.starttls} onChange={(starttls) => patch({ starttls })} label="启用 STARTTLS" />
        <Switch checked={form.ssl} onChange={(ssl) => patch({ ssl })} label="启用 SSL" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">SMTP 主机<input className="km-input w-full" value={form.host} onChange={(event) => patch({ host: event.target.value })} /></label>
        <label className="block space-y-1 text-sm">SMTP 端口<input className="km-input w-full" value={form.port} onChange={(event) => patch({ port: event.target.value })} /></label>
        <label className="block space-y-1 text-sm">SMTP 用户名<input className="km-input w-full" value={form.user} onChange={(event) => patch({ user: event.target.value })} /></label>
        <label className="block space-y-1 text-sm">
          SMTP 密码
          <input className="km-input w-full" type="password" placeholder={form.passwordConfigured ? "留空表示保持不变" : ""} value={form.password} onChange={(event) => patch({ password: event.target.value })} />
        </label>
        <label className="block space-y-1 text-sm">
          发件邮箱
          <input className="km-input w-full" placeholder="noreply@你的域名" value={form.from} onChange={(event) => patch({ from: event.target.value })} />
        </label>
        <label className="block space-y-1 text-sm">
          默认发件人名称
          <input className="km-input w-full" value={form.fromName} onChange={(event) => patch({ fromName: event.target.value })} />
        </label>
      </div>
      <button type="button" className="km-btn" disabled={busy} onClick={() => void save()}>保存邮件配置</button>
      <div className="grid gap-3 border-t border-[var(--km-border)] pt-4 sm:grid-cols-[1fr_auto]">
        <label className="block space-y-1 text-sm">
          测试发送
          <input className="km-input w-full" placeholder="输入收件邮箱" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <button type="button" className="km-btn km-btn-ghost self-end" disabled={busy} onClick={() => void testSend()}>发送测试</button>
      </div>
      {message ? <p className="text-sm">{message}</p> : null}
    </section>
  );
}

export function AdminTelegramBindings() {
  const [rows, setRows] = useState<Array<{ id: number; name: string; username: string; enabled: boolean }>>([]);
  const [pollError, setPollError] = useState("");

  useEffect(() => {
    fetch("/api/admin/notify/bindings", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        setRows(Array.isArray(data.list) ? data.list : []);
        setPollError(typeof data.pollError === "string" ? data.pollError : "");
      })
      .catch(() => undefined);
  }, []);

  return (
    <section className="km-panel space-y-3">
      <div>
        <h2 className="text-xl font-semibold">代理绑定</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          只读。代理在自己的后台生成绑定码，对机器人发送 /bind。这个机器人不能再设置 Webhook，否则绑定码收不到。
        </p>
      </div>
      {pollError ? <p className="text-sm text-[var(--km-fg-muted)]">绑定轮询失败：{pollError}</p> : null}
      {rows.length ? (
        <ul className="space-y-2 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{row.name}{row.username ? ` · @${row.username}` : ""}</span>
              <span className="text-[var(--km-fg-muted)]">{row.enabled ? "接收通知" : "已暂停"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">还没有代理绑定。</p>
      )}
    </section>
  );
}
