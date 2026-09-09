"use client";

import { useEffect, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { hasNextPage, pageLabel } from "@/lib/pagination-core";

type FinishedRow = {
  id: number;
  email: string;
  status: string;
  importedAt: string;
  soldAt: string | null;
  orderNo: string;
  agentName: string;
  gptPasswordMasked: string;
  mailboxPasswordMasked: string;
  sessionMasked: string;
};

type ListResponse = {
  counts: { unused: number; sold: number; disabled: number };
  page: number;
  pageSize: number;
  total: number;
  list: FinishedRow[];
  error?: string;
};

const STATUS_LABEL: Record<string, string> = {
  unused: "未售",
  sold: "已售",
  disabled: "已作废",
};

export function FinishedAccountsAdmin() {
  const { ask, dialog } = useAskDialog();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);

  async function load(nextPage = page, nextStatus = status, nextQ = q) {
    const params = new URLSearchParams({
      page: String(nextPage),
      pageSize: "20",
    });
    if (nextStatus) params.set("status", nextStatus);
    if (nextQ.trim()) params.set("q", nextQ.trim());
    const response = await fetch(`/api/admin/finished-accounts?${params}`, {
      cache: "no-store",
    });
    const json = (await response.json()) as ListResponse;
    if (!response.ok) throw new Error(json.error || "成品号库存加载失败");
    setData(json);
    setPage(nextPage);
  }

  useEffect(() => {
    void load(1).catch((error) => {
      toast(error instanceof Error ? error.message : "成品号库存加载失败", "err");
    });
    // 首次进入拉一页即可，筛选走按钮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function importLines() {
    if (!text.trim()) {
      toast("先粘贴要入库的成品号", "err");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/admin/finished-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "入库失败");
      const skipped = json.skipped?.length || 0;
      const rejected = json.rejected?.length || 0;
      toast(
        `入库 ${json.imported} 条` +
          (skipped ? `，跳过 ${skipped}` : "") +
          (rejected ? `，失败 ${rejected}` : ""),
      );
      if (rejected) {
        const first = json.rejected[0];
        toast(`第 ${first.line} 行：${first.reason}`, "err");
      }
      setText("");
      await load(1);
    } catch (error) {
      toast(error instanceof Error ? error.message : "入库失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function disableRow(row: FinishedRow) {
    const ok = await ask({
      title: "作废这枚成品号？",
      message: `${row.email} 作废后不能再卖。`,
      confirmLabel: "作废",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/finished-accounts/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "作废失败");
      toast("已作废");
      await load(page);
    } catch (error) {
      toast(error instanceof Error ? error.message : "作废失败", "err");
    } finally {
      setBusy(false);
    }
  }

  const counts = data?.counts || { unused: 0, sold: 0, disabled: 0 };

  return (
    <div className="space-y-4">
      {dialog}
      <section className="km-panel space-y-3">
        <div>
          <h2 className="text-xl font-semibold">成品号库存</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            一行一枚，格式：邮箱----GPT密码----邮箱密码----Session。库存对代理和买家都不显示数量，有货显示「有货」，卖完仍上架为「补货中」。
          </p>
        </div>
        <p className="text-sm">
          未售 <strong>{counts.unused}</strong> · 已售 {counts.sold} · 已作废{" "}
          {counts.disabled}
        </p>
        <textarea
          className="km-input min-h-36 font-mono text-xs"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"user@example.com----gptPass----mailPass----session..."}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="km-btn"
            disabled={busy}
            onClick={() => void importLines()}
          >
            {busy ? "处理中…" : "入库"}
          </button>
          <label className="km-btn km-btn-ghost cursor-pointer">
            从文件导入
            <input
              type="file"
              accept=".txt,.csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void file.text().then((value) => setText(value));
              }}
            />
          </label>
        </div>
      </section>

      <section className="km-panel space-y-3">
        <div className="flex flex-wrap gap-2">
          <input
            className="km-input w-56"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="按邮箱搜索"
          />
          <select
            className="km-input w-32"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">全部状态</option>
            <option value="unused">未售</option>
            <option value="sold">已售</option>
            <option value="disabled">已作废</option>
          </select>
          <button
            type="button"
            className="km-btn"
            onClick={() =>
              void load(1, status, q).catch((error) =>
                toast(error instanceof Error ? error.message : "筛选失败", "err"),
              )
            }
          >
            筛选
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)] text-[var(--km-fg-muted)]">
                <th className="py-2 pr-3">邮箱</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2 pr-3">密码 / Session</th>
                <th className="py-2 pr-3">订单</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {(data?.list || []).map((row) => (
                <tr key={row.id} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3 font-mono">{row.email}</td>
                  <td className="py-2 pr-3">{STATUS_LABEL[row.status] || row.status}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-[var(--km-fg-muted)]">
                    {row.gptPasswordMasked} / {row.mailboxPasswordMasked} /{" "}
                    {row.sessionMasked}
                  </td>
                  <td className="py-2 pr-3">
                    {row.orderNo ? (
                      <div>
                        <div className="font-mono text-xs">{row.orderNo}</div>
                        <div className="text-xs text-[var(--km-fg-muted)]">
                          {row.agentName}
                        </div>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2">
                    {row.status === "unused" ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={busy}
                        onClick={() => void disableRow(row)}
                      >
                        作废
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--km-fg-muted)]">
            <span>{pageLabel(data.total, data.page, data.pageSize)}</span>
            <button
              type="button"
              className="km-btn km-btn-ghost"
              disabled={data.page <= 1}
              onClick={() =>
                void load(data.page - 1).catch((error) =>
                  toast(error instanceof Error ? error.message : "翻页失败", "err"),
                )
              }
            >
              上一页
            </button>
            <button
              type="button"
              className="km-btn km-btn-ghost"
              disabled={!hasNextPage(data.total, data.page, data.pageSize)}
              onClick={() =>
                void load(data.page + 1).catch((error) =>
                  toast(error instanceof Error ? error.message : "翻页失败", "err"),
                )
              }
            >
              下一页
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
