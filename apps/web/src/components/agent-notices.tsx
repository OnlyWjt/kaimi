"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { AgentAnnouncementRow } from "@/lib/announcements-core";
import { parseDbDate } from "@/lib/datetime";

export type AgentNoticesSnapshot = {
  current: AgentAnnouncementRow | null;
  unread: boolean;
  history: AgentAnnouncementRow[];
};

function formatWhen(value: string | null) {
  if (!value) return "—";
  const date = parseDbDate(value);
  if (!date) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function NoticeCard({
  item,
  live,
}: {
  item: AgentAnnouncementRow;
  live?: boolean;
}) {
  return (
    <article className="km-panel space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`km-badge ${live ? "km-badge-ok" : ""}`}>
          {live ? "正在生效" : "已下线"}
        </span>
        <span className="text-sm text-[var(--km-fg-muted)]">
          {formatWhen(item.publishedAt)}
        </span>
      </div>
      <h2 className="text-lg font-semibold">{item.title}</h2>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{item.body}</p>
    </article>
  );
}

export function AgentNotices({ snapshot }: { snapshot: AgentNoticesSnapshot }) {
  const router = useRouter();

  useEffect(() => {
    if (!snapshot.current || !snapshot.unread) return;
    void fetch(`/api/agent/announcements/${snapshot.current.id}/read`, {
      method: "POST",
    }).then((res) => {
      if (res.ok) router.refresh();
    });
  }, [snapshot.current, snapshot.unread, router]);

  const empty = !snapshot.current && snapshot.history.length === 0;

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>平台公告</h1>
          <p>平台改价、维护、结算口径会写在这里。顾客店里看不到。</p>
        </div>
      </header>
      {empty ? (
        <section className="km-panel">
          <p className="text-sm text-[var(--km-fg-muted)]">暂时没有平台公告。</p>
        </section>
      ) : (
        <div className="space-y-3">
          {snapshot.current ? <NoticeCard item={snapshot.current} live /> : null}
          {snapshot.history.map((item) => (
            <NoticeCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </>
  );
}
