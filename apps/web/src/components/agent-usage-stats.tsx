"use client";

import { useEffect, useState } from "react";
import {
  UsageStatsPanel,
  type UsageStatsPayload,
} from "@/components/usage-stats-panel";
import { readApiJson } from "@/lib/http-error";

function localYmd(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function AgentUsageStats({
  range,
  planName,
}: {
  range: string;
  planName: (planKey: string) => string;
}) {
  const [data, setData] = useState<UsageStatsPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError("");
      try {
        const now = new Date();
        const end = localYmd(now);
        let start = end;
        if (range === "all") start = "2020-01-01";
        else if (range === "month") {
          start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        } else if (range !== "today") {
          start = localYmd(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
        }
        const payload = await readApiJson<UsageStatsPayload>(
          await fetch(`/api/agent/usage/stats?start=${start}&end=${end}`, {
            cache: "no-store",
          }),
        );
        if (!cancelled) setData(payload);
      } catch (reason) {
        if (!cancelled) {
          setData(null);
          setError(reason instanceof Error ? reason.message : "用量加载失败");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <section className="km-panel space-y-4">
      <div>
        <h2 className="text-xl font-semibold">用量</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          和下方收益用同一段时间。未兑换积压是当前还没兑的卡，不只看这一段新发出的。
        </p>
      </div>
      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
      {data ? (
        <UsageStatsPanel
          data={data}
          planName={(planKey, fallback) => planName(planKey) || fallback}
        />
      ) : !error ? (
        <p className="text-sm text-[var(--km-fg-muted)]">正在汇总…</p>
      ) : null}
    </section>
  );
}
