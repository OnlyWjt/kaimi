"use client";

import { useState } from "react";
import { toast } from "@/components/toast";

/** 列表里默认打码。点一下才向服务器要完整卡密，每次查看都会记审计。 */
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
      setOpen(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : "查看失败", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="font-mono text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
      title={open ? "点击收起" : "点击查看完整卡密"}
      disabled={busy || !itemId}
      onClick={() => void toggle()}
    >
      {busy ? "查看中…" : open && code ? code : masked}
    </button>
  );
}
