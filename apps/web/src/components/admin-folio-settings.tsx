"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/admin-mail-settings";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";

type Snapshot = {
  enabled: boolean;
  baseUrl: string;
  secretConfigured: boolean;
  secretTail: string;
  businessBaseUrl: string;
  callbackUrl: string;
};

/** 「通知」页里的 Folio 开票对接：开关、地址、共用密钥，以及要复制到 Folio 的两个地址。 */
export function AdminFolioSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(data: Snapshot) {
    setSnapshot(data);
    setEnabled(data.enabled);
    setBaseUrl(data.baseUrl);
    setSecret("");
  }

  useEffect(() => {
    fetch("/api/admin/folio", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (data && !data.error) apply(data);
      })
      .catch(() => undefined);
  }, []);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/folio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作失败");
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const data = await post({ action: "save", enabled, baseUrl, secret: secret || undefined });
    if (!data) return;
    apply(data);
    setMessage(data.enabled ? "已保存，Folio 对接已开启" : "已保存，Folio 对接关闭");
  }

  async function selfTest() {
    const data = await post({ action: "self_test" });
    if (!data) return;
    setMessage(
      data.ok
        ? "签名自测通过：和 Folio 约定的自测向量一致"
        : `签名自测不通过：期望 ${data.expected}，算出 ${data.actual}`,
    );
  }

  function copy(value: string) {
    void copyText(value)
      .then(() => toast("已复制"))
      .catch((error) => toast(error instanceof Error ? error.message : "复制失败", "err"));
  }

  if (!snapshot) return null;
  const addresses: Array<[string, string]> = [
    ["业务系统地址", snapshot.businessBaseUrl],
    ["回调地址", snapshot.callbackUrl],
  ];

  return (
    <section className="km-panel space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Folio 开票对接</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            买家付款后自动把开票申请推给 Folio。Folio 发出发票后回调本站，再用代理绑定的 Telegram 通知代理。关闭时和没接 Folio 一样。
          </p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label="启用对接" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span>Folio 地址</span>
          <input
            className="km-input w-full"
            placeholder="https://folio.example.com"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>共用密钥</span>
          <input
            className="km-input w-full font-mono"
            type="password"
            autoComplete="off"
            placeholder={
              snapshot.secretConfigured ? `已设置 ••••${snapshot.secretTail}，留空则不修改` : "Folio「业务对接」页生成后粘贴到这里"
            }
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
      </div>
      <div className="space-y-2 rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
        <p className="text-xs text-[var(--km-fg-muted)]">填到 Folio「业务对接」页</p>
        {snapshot.businessBaseUrl ? (
          addresses.map(([label, value]) => (
            <div key={label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[var(--km-fg-muted)]">{label}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
                {value}
              </code>
              <button type="button" className="km-btn km-btn-ghost km-btn-sm shrink-0" onClick={() => copy(value)}>
                复制
              </button>
            </div>
          ))
        ) : (
          <p className="text-[var(--km-fg-muted)]">先在上面填好本站公网地址，这里才会显示要复制给 Folio 的地址。</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="km-btn" disabled={busy} onClick={() => void save()}>
          保存 Folio 设置
        </button>
        <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void selfTest()}>
          签名自测
        </button>
        {message ? <span className="text-sm">{message}</span> : null}
      </div>
    </section>
  );
}
