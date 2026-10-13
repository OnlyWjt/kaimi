"use client";

import { useState } from "react";
import { toast } from "@/components/toast";

type FinishedAccount = {
  email: string;
  gptPassword: string;
  mailboxPassword: string;
  session: string;
};

/** 列表里默认打码。点一下才向服务器要完整卡密，每次查看都会记审计。成品号拆成四段显示。 */
export function DrawCodePeek({
  itemId,
  masked,
  href,
}: {
  itemId: number;
  masked: string;
  href: string;
}) {
  const [code, setCode] = useState("");
  const [account, setAccount] = useState<FinishedAccount | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    if (code) {
      setOpen(true);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(href, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "查看失败");
      setCode(String(data.code || ""));
      setAccount(data.account || null);
      setOpen(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : "查看失败", "err");
    } finally {
      setBusy(false);
    }
  }

  if (open && account) {
    return (
      <div className="space-y-1 text-xs">
        <FinishedAccountLines account={account} />
        <div className="flex gap-2">
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2"
            onClick={() => void navigator.clipboard.writeText(code).then(() => toast("已复制"))}
          >
            复制整行
          </button>
          <button type="button" className="underline decoration-dotted underline-offset-2" onClick={() => setOpen(false)}>
            收起
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="font-mono text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
      title={open ? "点击收起" : "点击查看完整内容"}
      disabled={busy || !itemId}
      onClick={() => void toggle()}
    >
      {busy ? "查看中…" : open && code ? code : masked}
    </button>
  );
}

export function FinishedAccountLines({ account }: { account: FinishedAccount }) {
  const rows: Array<[string, string]> = [
    ["邮箱", account.email],
    ["GPT 密码", account.gptPassword],
    ["邮箱密码", account.mailboxPassword],
    ["Session", account.session],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[var(--km-fg-muted)]">{label}</dt>
          <dd className="max-w-[28rem] truncate font-mono" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
