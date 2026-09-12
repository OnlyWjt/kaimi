"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/toast";
import type { UnreadAnnouncement } from "@/lib/announcements-core";
import { messageFromApiBody } from "@/lib/http-error";

export function AgentAnnouncementModal({
  item,
  onRead,
}: {
  item: UnreadAnnouncement;
  onRead: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function markRead() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch(`/api/agent/announcements/${item.id}/read`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(messageFromApiBody(payload, "没记上，请再点一次"));
      }
      onRead();
    } catch (reason) {
      busyRef.current = false;
      setBusy(false);
      toast(reason instanceof Error ? reason.message : "没记上，请再点一次", "err");
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") void markRead();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item.id]);

  return (
    <div className="km-modal-backdrop" onClick={() => void markRead()}>
      <div
        className="km-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="km-announcement-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-xs text-[var(--km-fg-muted)]">平台公告</p>
        <h2 id="km-announcement-title" className="mt-1 text-lg font-semibold">
          {item.title}
        </h2>
        <p className="mt-3 max-h-[70vh] overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-[var(--km-fg-muted)]">
          {item.body}
        </p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="km-btn"
            disabled={busy}
            autoFocus
            onClick={() => void markRead()}
          >
            {busy ? "记下…" : "知道了"}
          </button>
        </div>
      </div>
    </div>
  );
}
