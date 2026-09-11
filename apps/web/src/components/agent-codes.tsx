"use client";

import { FormEvent, useEffect, useState } from "react";
import { type AgentPlanRow } from "@/lib/agent-console-core";
import { readApiJson } from "@/lib/http-error";
import { hasNextPage, pageLabel } from "@/lib/pagination-core";
import { publicStatusLabel } from "@/lib/status-labels";

type AgentCdk = {
  id: number;
  code: string;
  planKey: string;
  status: string;
  orderNo: string;
};

const PAGE_SIZE = 10;

export function AgentCodes() {
  const [plans, setPlans] = useState<AgentPlanRow[]>([]);
  const [cdks, setCdks] = useState<AgentCdk[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  function planName(planKey: string) {
    return plans.find((plan) => plan.planKey === planKey)?.name || planKey;
  }

  useEffect(() => {
    void (async () => {
      try {
        const data = await readApiJson<{ list?: AgentPlanRow[] }>(
          await fetch("/api/agent/plans", { cache: "no-store" }),
        );
        setPlans(data.list || []);
      } catch {
        /* 套餐名只是展示，失败就退回 planKey */
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const qs = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
        });
        if (query.trim()) qs.set("q", query.trim());
        const data = await readApiJson<{ list?: AgentCdk[]; total?: number; page?: number }>(
          await fetch(`/api/agent/cdks?${qs}`, { cache: "no-store" }),
        );
        if (cancelled) return;
        setCdks(data.list || []);
        setTotal(Number(data.total) || 0);
        setPage(Number(data.page) || page);
        setError("");
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "卡密加载失败");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [page, query]);

  async function reveal(id: number) {
    try {
      const data = await readApiJson<{ code: string }>(
        await fetch(`/api/agent/cdks/${id}/reveal`, { method: "POST" }),
      );
      setCdks((current) =>
        current.map((item) => (item.id === id ? { ...item, code: data.code } : item)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "卡密读取失败");
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(q.trim());
  }

  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>已售卡密</h1>
          <p>这是售后台，不是库存。买家说没收到，来这里对订单号。</p>
        </div>
      </header>
      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
      <section className="km-panel space-y-4">
        <form className="flex flex-wrap gap-2" onSubmit={search}>
          <input
            className="km-input max-w-xs"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="订单号"
          />
          <button type="submit" className="km-btn km-btn-ghost">
            筛选
          </button>
        </form>
        <div className="overflow-x-auto">
          <table className="km-acp-price">
            <thead>
              <tr>
                <th>卡密</th>
                <th>套餐</th>
                <th>订单</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {cdks.map((cdk) => (
                <tr key={cdk.id}>
                  <td className="font-mono text-xs">{cdk.code}</td>
                  <td>{planName(cdk.planKey)}</td>
                  <td className="font-mono text-xs">{cdk.orderNo}</td>
                  <td>
                    <span className={`km-acp-pill${cdk.status === "unused" ? " warn" : ""}`}>
                      {publicStatusLabel(cdk.status, "cdk")}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="km-btn km-btn-ghost"
                      onClick={() => void reveal(cdk.id)}
                    >
                      显示完整卡密
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!cdks.length ? (
            <p className="py-8 text-center text-sm text-[var(--km-fg-muted)]">
              {query ? "没有匹配的卡密" : "还没有售出卡密"}
            </p>
          ) : null}
        </div>
        {total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--km-border)] pt-3 text-sm">
            <span className="text-[var(--km-fg-muted)]">{pageLabel(total, page, PAGE_SIZE)}</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={!hasNextPage(total, page, PAGE_SIZE)}
                onClick={() => setPage((current) => current + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
