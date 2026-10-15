"use client";

import { useEffect, useState } from "react";
import { loadAdminSection, postAdminAction } from "@/components/admin-api";
import { StatusBadge, formatWhen } from "@/components/admin-ui";
import { useAskDialog } from "@/components/ask-dialog";
import { KmSelect } from "@/components/km-select";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";

const PAGE_SIZE = 20;

type CdkPage = { list?: Array<Record<string, unknown>>; total?: number; page?: number };

/** 「日常 › 卡密」：店铺卖出去的卡密，默认脱敏。 */
export function AdminCdks() {
  const { ask, dialog } = useAskDialog();
  const [cdks, setCdks] = useState<Array<Record<string, unknown>>>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);

  async function load(nextPage = page, filters = { q, status }) {
    const qs = new URLSearchParams();
    if (filters.q) qs.set("q", filters.q);
    if (filters.status) qs.set("status", filters.status);
    qs.set("page", String(nextPage));
    qs.set("page_size", String(PAGE_SIZE));
    const data = await loadAdminSection<CdkPage>("stock", qs.toString());
    setCdks(data?.list || []);
    setTotal(Number(data?.total) || 0);
    setPage(Number(data?.page) || nextPage);
  }

  useEffect(() => {
    void load(1);
    // 只在打开页签时拉第一页，之后靠筛选和翻页
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyCode(id: number, code: string) {
    try {
      await copyText(code);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  async function reveal(id: number) {
    const data = await postAdminAction({ action: "reveal_cdk", id });
    if (data?.code) setRevealed((prev) => ({ ...prev, [id]: String(data.code) }));
  }

  async function op(action: "void_cdk" | "disable_cdk" | "enable_cdk", id: number) {
    const label = action === "void_cdk" ? "核销" : action === "disable_cdk" ? "禁用" : "启用";
    const ok = await ask({ title: `确认${label}该卡密？`, confirmLabel: label, danger: action !== "enable_cdk" });
    if (!ok) return;
    await postAdminAction({ action, id });
    await load();
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="km-panel overflow-x-auto text-sm">
      {dialog}
      <div className="km-toolbar">
        <input
          className="km-input max-w-xs font-mono"
          placeholder="订单号 / 完整卡密 / 套餐键"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(1);
          }}
        />
        <KmSelect
          className="w-40"
          value={status}
          placeholder="全部状态"
          options={[
            { value: "", label: "全部状态" },
            { value: "unused", label: "未使用" },
            { value: "used", label: "已核销" },
            { value: "disabled", label: "已禁用" },
          ]}
          onChange={(next) => {
            setStatus(next);
            void load(1, { q, status: next });
          }}
        />
        <button className="km-btn" onClick={() => void load(1)}>
          筛选
        </button>
        <span className="ml-auto text-xs text-[var(--km-fg-muted)]">
          共 {total} 条店铺已售卡密 · 默认脱敏，点「显示」后再复制
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="km-table km-cdk-table">
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "9%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>卡密</th>
              <th>商品</th>
              <th>订单 / 买家</th>
              <th>代理</th>
              <th>状态</th>
              <th>更新</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {cdks.map((c) => {
              const rowStatus = String(c.status);
              const id = Number(c.id);
              const code = revealed[id] || "";
              const display = code || String(c.codeMasked || "");
              const planKey = String(c.planKey || "");
              const productName = String(c.productName || "") || planKey || "—";
              const canVoid = rowStatus !== "used" && rowStatus !== "disabled" && rowStatus !== "locked";
              const canDisable = rowStatus === "unused" || rowStatus === "sold";
              return (
                <tr key={String(c.id)}>
                  <td>
                    <div className="km-cdk-code">
                      <code className="km-clip" title={display}>
                        {display}
                      </code>
                      <button
                        type="button"
                        className="km-cdk-link"
                        onClick={() => void (code ? copyCode(id, code) : reveal(id))}
                      >
                        {code ? (copiedId === id ? "已复制" : "复制") : "显示"}
                      </button>
                    </div>
                  </td>
                  <td>
                    <p className="km-clip font-medium" title={productName}>
                      {productName}
                    </p>
                    {planKey && planKey !== productName ? (
                      <p className="km-clip font-mono text-xs text-[var(--km-fg-muted)]" title={planKey}>
                        {planKey}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <p className="km-clip font-mono text-xs" title={String(c.orderNo || "")}>
                      {String(c.orderNo || "—")}
                    </p>
                    {c.customerEmail ? (
                      <p className="km-clip text-xs text-[var(--km-fg-muted)]" title={String(c.customerEmail)}>
                        {String(c.customerEmail)}
                      </p>
                    ) : null}
                  </td>
                  <td className="km-clip" title={String(c.agentName || "")}>
                    {String(c.agentName || "—")}
                  </td>
                  <td>
                    <StatusBadge status={rowStatus} />
                  </td>
                  <td className="whitespace-nowrap text-xs text-[var(--km-fg-muted)]" title={String(c.updatedAt || "")}>
                    {formatWhen(c.updatedAt)}
                  </td>
                  <td>
                    <div className="km-cdk-actions">
                      {canVoid ? (
                        <button className="km-btn km-btn-ghost km-btn-sm" onClick={() => void op("void_cdk", id)}>
                          核销
                        </button>
                      ) : null}
                      {canDisable ? (
                        <button
                          className="km-btn km-btn-ghost km-btn-sm text-[var(--km-danger)]"
                          onClick={() => void op("disable_cdk", id)}
                        >
                          禁用
                        </button>
                      ) : null}
                      {rowStatus === "disabled" ? (
                        <button
                          className="km-btn km-btn-ghost km-btn-sm text-[var(--km-success)]"
                          onClick={() => void op("enable_cdk", id)}
                        >
                          启用
                        </button>
                      ) : null}
                      {!canVoid && !canDisable && rowStatus !== "disabled" ? (
                        <span className="text-xs text-[var(--km-fg-muted)]">—</span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!cdks.length ? <p className="py-8 text-center text-[var(--km-fg-muted)]">还没有店铺售出的卡密</p> : null}

      {total > 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--km-border)] pt-3">
          <span className="text-[var(--km-fg-muted)]">
            第 {page} / {pageCount} 页
          </span>
          <div className="flex gap-2">
            <button className="km-btn km-btn-ghost" disabled={page <= 1} onClick={() => void load(Math.max(1, page - 1))}>
              上一页
            </button>
            <button className="km-btn km-btn-ghost" disabled={page * PAGE_SIZE >= total} onClick={() => void load(page + 1)}>
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
