"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { formatDateTime } from "@/lib/datetime";

type BlockRow = {
  id: number;
  subjectType: string;
  subject: string;
  reason: string;
  blockedUntil: string;
};

type FailureRow = {
  subjectType: string;
  subject: string;
  count: number;
};

export function AdminRedeemGuard() {
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [failures, setFailures] = useState<FailureRow[]>([]);

  async function reload() {
    const response = await fetch("/api/admin/redeem-guard");
    const data = await response.json();
    if (!response.ok) {
      toast(data.error || "加载失败", "err");
      return;
    }
    setBlocks(data.blocks || []);
    setFailures(data.failures || []);
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="space-y-4">
      <section className="km-panel overflow-x-auto">
        <h2 className="mb-3 text-xl font-semibold">当前封锁</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]">
              <th className="py-2 pr-3">对象</th>
              <th className="py-2 pr-3">原因</th>
              <th className="py-2 pr-3">解封时间</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {blocks.map((row) => (
              <tr key={row.id} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">
                  {row.subjectType} {row.subject}
                </td>
                <td className="py-2 pr-3">{row.reason}</td>
                <td className="py-2 pr-3">{formatDateTime(row.blockedUntil)}</td>
                <td className="py-2">
                  <button
                    className="km-btn km-btn-ghost"
                    onClick={async () => {
                      const response = await fetch(`/api/admin/redeem-guard?id=${row.id}`, {
                        method: "DELETE",
                      });
                      if (!response.ok) {
                        toast("解封失败", "err");
                        return;
                      }
                      toast("已解封");
                      await reload();
                    }}
                  >
                    解封
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!blocks.length ? <p className="py-3 text-[var(--km-fg-muted)]">没有封锁</p> : null}
      </section>
      <section className="km-panel overflow-x-auto">
        <h2 className="mb-3 text-xl font-semibold">近 24 小时失败</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--km-border)]">
              <th className="py-2 pr-3">对象</th>
              <th className="py-2">次数</th>
            </tr>
          </thead>
          <tbody>
            {failures.map((row) => (
              <tr key={`${row.subjectType}:${row.subject}`} className="border-b border-[var(--km-border)]">
                <td className="py-2 pr-3">
                  {row.subjectType} {row.subject}
                </td>
                <td className="py-2">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!failures.length ? <p className="py-3 text-[var(--km-fg-muted)]">没有失败记录</p> : null}
      </section>
    </div>
  );
}
