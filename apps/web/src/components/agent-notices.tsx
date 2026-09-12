"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { AgentAnnouncementRow } from "@/lib/announcements-core";
import { formatLocalMonthDayTime } from "@/lib/datetime";

export type AgentNoticesSnapshot = {
  current: AgentAnnouncementRow | null;
  unread: boolean;
  history: AgentAnnouncementRow[];
};

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
        <section className="km-acp-notice km-acp-notice-empty">
          <p>暂时没有平台公告。</p>
        </section>
      ) : (
        <div className="km-acp-notice-stack">
          {snapshot.current ? (
            <article className="km-acp-notice">
              <time dateTime={snapshot.current.publishedAt}>
                {formatLocalMonthDayTime(snapshot.current.publishedAt)}
              </time>
              <h2>{snapshot.current.title}</h2>
              <p className="km-acp-notice-body">{snapshot.current.body}</p>
            </article>
          ) : null}
          {snapshot.history.length > 0 ? (
            <section className="km-acp-notice-history">
              <h3>以往公告</h3>
              <ul>
                {snapshot.history.map((item) => (
                  <li key={item.id} className="km-acp-notice-past">
                    <div className="km-acp-notice-past-head">
                      <strong>{item.title}</strong>
                      <time dateTime={item.publishedAt}>
                        {formatLocalMonthDayTime(item.publishedAt)}
                      </time>
                    </div>
                    <p className="km-acp-notice-body">{item.body}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}
