"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_STATUS_LABEL,
  ANNOUNCEMENT_TITLE_MAX,
  normalizeAnnouncementBody,
  normalizeAnnouncementTitle,
  type AdminAnnouncementRow,
  type AnnouncementStatus,
} from "@/lib/announcements-core";
import { parseDbDate } from "@/lib/datetime";
import { messageFromApiBody, readApiJson } from "@/lib/http-error";

type EditorMode = "new" | "draft" | "live";

type ListPayload = {
  current: AdminAnnouncementRow | null;
  drafts: AdminAnnouncementRow[];
  history: AdminAnnouncementRow[];
  activeAgentCount: number;
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

function statusBadge(status: AnnouncementStatus) {
  const tone =
    status === "published" ? "km-badge-ok" : status === "draft" ? "km-badge-wait" : "";
  return <span className={`km-badge ${tone}`}>{ANNOUNCEMENT_STATUS_LABEL[status]}</span>;
}

export function AdminAnnouncements() {
  const { ask, dialog } = useAskDialog();
  const [data, setData] = useState<ListPayload | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<EditorMode>("new");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState("");

  const titleCount = normalizeAnnouncementTitle(title).length;
  const bodyCount = normalizeAnnouncementBody(body).length;

  const load = useCallback(async () => {
    try {
      setData(await readApiJson<ListPayload>(await fetch("/api/admin/announcements")));
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "公告加载失败", "err");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    return [...data.drafts, ...data.history].sort((a, b) => {
      if (a.updatedAt === b.updatedAt) return b.id - a.id;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  }, [data]);

  function resetEditor() {
    setMode("new");
    setEditingId(null);
    setTitle("");
    setBody("");
  }

  function fillEditor(row: AdminAnnouncementRow, next: EditorMode) {
    setMode(next);
    setEditingId(row.id);
    setTitle(row.title);
    setBody(row.body);
  }

  async function request(
    url: string,
    init: RequestInit,
    successFallback: string,
  ) {
    const res = await fetch(url, init);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(messageFromApiBody(payload, "操作失败"));
    }
    toast(typeof payload.message === "string" ? payload.message : successFallback);
    await load();
  }

  async function saveDraft() {
    setBusy("draft");
    try {
      if (mode === "draft" && editingId) {
        await request(
          `/api/admin/announcements/${editingId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, body }),
          },
          "已存草稿",
        );
      } else {
        await request(
          "/api/admin/announcements",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, body, publish: false }),
          },
          "已存草稿",
        );
      }
      resetEditor();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function publishCurrent() {
    const answer = await ask({
      title: "发布给全部代理",
      message: "发布后，代理下次打开后台会看到弹层。现在这条会自动下线，顾客店里不会出现。",
      confirmLabel: "发布",
      cancelLabel: "不发",
    });
    if (!answer) return;
    setBusy("publish");
    try {
      if (mode === "draft" && editingId) {
        await request(
          `/api/admin/announcements/${editingId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, body }),
          },
          "已存草稿",
        );
        await request(
          `/api/admin/announcements/${editingId}/publish`,
          { method: "POST" },
          "已发布，代理下次打开后台会看到",
        );
      } else {
        await request(
          "/api/admin/announcements",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, body, publish: true }),
          },
          "已发布，代理下次打开后台会看到",
        );
      }
      resetEditor();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "发布失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function publishSavedDraft(row: AdminAnnouncementRow) {
    const answer = await ask({
      title: "发布给全部代理",
      message: "发布后，代理下次打开后台会看到弹层。现在这条会自动下线，顾客店里不会出现。",
      confirmLabel: "发布",
      cancelLabel: "不发",
    });
    if (!answer) return;
    setBusy("publish");
    try {
      await request(
        `/api/admin/announcements/${row.id}/publish`,
        { method: "POST" },
        "已发布，代理下次打开后台会看到",
      );
      if (editingId === row.id) resetEditor();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "发布失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function saveLive() {
    if (!editingId) return;
    setBusy("save");
    try {
      await request(
        `/api/admin/announcements/${editingId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, body }),
        },
        "已改好，看过的人不会再弹一次",
      );
      resetEditor();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function archive(id: number) {
    const answer = await ask({
      title: "下线这条公告",
      message: "下线后不再弹层，代理仍能在公告页翻到。",
      confirmLabel: "下线",
      cancelLabel: "留下",
    });
    if (!answer) return;
    setBusy(`archive-${id}`);
    try {
      await request(
        `/api/admin/announcements/${id}/archive`,
        { method: "POST" },
        "已下线",
      );
      if (editingId === id) resetEditor();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "下线失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function discard(id: number) {
    const answer = await ask({
      title: "丢掉草稿",
      message: "草稿会删掉。发过的公告不能删。",
      confirmLabel: "丢掉",
      cancelLabel: "留下",
      danger: true,
    });
    if (!answer) return;
    setBusy(`discard-${id}`);
    try {
      await request(`/api/admin/announcements/${id}`, { method: "DELETE" }, "草稿已删");
      if (editingId === id) resetEditor();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "删除失败", "err");
    } finally {
      setBusy("");
    }
  }

  const current = data?.current ?? null;
  const editorTitle =
    mode === "live" ? "改现在这条" : mode === "draft" ? "改草稿" : "写一条";

  return (
    <div className="space-y-4">
      <section className="km-panel space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">公告</h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              写给代理看的。顾客店里、兑换页都不会出现。改已发出的字不会再弹一次；要所有人再看一遍，就新写一条发布。
            </p>
          </div>
          <button type="button" className="km-btn km-btn-ghost" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </section>

      {current ? (
        <section className="km-panel space-y-3">
          <p className="text-xs text-[var(--km-fg-muted)]">现在生效</p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">{current.title}</h3>
              <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
                发布于 {formatWhen(current.publishedAt)} · 已读 {current.readCount} /{" "}
                {data?.activeAgentCount ?? 0}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="km-btn km-btn-ghost"
                onClick={() => fillEditor(current, "live")}
              >
                改字
              </button>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={busy.startsWith("archive")}
                onClick={() => void archive(current.id)}
              >
                下线
              </button>
            </div>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{current.body}</p>
        </section>
      ) : null}

      <section className="km-panel space-y-3">
        <div>
          <h3 className="font-semibold">{editorTitle}</h3>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            纯文本，保留换行。标题约 40 字，正文约 800 字。
          </p>
        </div>
        <label className="block space-y-1 text-sm">
          <span>标题 {titleCount} / {ANNOUNCEMENT_TITLE_MAX}</span>
          <input
            className="km-input w-full"
            value={title}
            maxLength={ANNOUNCEMENT_TITLE_MAX + 8}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="下周一凌晨兑换暂停两小时"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>正文 {bodyCount} / {ANNOUNCEMENT_BODY_MAX}</span>
          <textarea
            className="km-input min-h-36 w-full"
            value={body}
            maxLength={ANNOUNCEMENT_BODY_MAX + 20}
            onChange={(event) => setBody(event.target.value)}
            placeholder="跟顾客就说维护，不要说库存。"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {mode === "live" ? (
            <button
              type="button"
              className="km-btn"
              disabled={Boolean(busy)}
              onClick={() => void saveLive()}
            >
              {busy === "save" ? "保存中…" : "保存改字"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="km-btn km-btn-ghost"
                disabled={Boolean(busy)}
                onClick={() => void saveDraft()}
              >
                {busy === "draft" ? "保存中…" : "存草稿"}
              </button>
              <button
                type="button"
                className="km-btn"
                disabled={Boolean(busy)}
                onClick={() => void publishCurrent()}
              >
                {busy === "publish" ? "发布中…" : "发布给全部代理"}
              </button>
            </>
          )}
          {mode !== "new" ? (
            <button type="button" className="km-btn km-btn-ghost" onClick={resetEditor}>
              取消
            </button>
          ) : null}
        </div>
      </section>

      <section className="km-panel space-y-3">
        <h3 className="font-semibold">历史</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--km-fg-muted)]">还没有写过公告。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="km-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>标题</th>
                  <th>时间</th>
                  <th>已读</th>
                  <th>动作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{statusBadge(row.status)}</td>
                    <td>{row.title}</td>
                    <td className="text-[var(--km-fg-muted)]">
                      {formatWhen(row.publishedAt || row.updatedAt)}
                    </td>
                    <td className="text-[var(--km-fg-muted)]">
                      {row.status === "draft"
                        ? "—"
                        : `${row.readCount} / ${data?.activeAgentCount ?? 0}`}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        {row.status === "draft" ? (
                          <>
                            <button
                              type="button"
                              className="km-btn km-btn-ghost"
                              onClick={() => fillEditor(row, "draft")}
                            >
                              继续写
                            </button>
                            <button
                              type="button"
                              className="km-btn km-btn-ghost"
                              disabled={Boolean(busy)}
                              onClick={() => void publishSavedDraft(row)}
                            >
                              发布
                            </button>
                            <button
                              type="button"
                              className="km-btn km-btn-ghost"
                              disabled={busy === `discard-${row.id}`}
                              onClick={() => void discard(row.id)}
                            >
                              丢掉
                            </button>
                          </>
                        ) : null}
                        {row.status === "published" ? (
                          <>
                            <button
                              type="button"
                              className="km-btn km-btn-ghost"
                              onClick={() => fillEditor(row, "live")}
                            >
                              改字
                            </button>
                            <button
                              type="button"
                              className="km-btn km-btn-ghost"
                              disabled={busy === `archive-${row.id}`}
                              onClick={() => void archive(row.id)}
                            >
                              下线
                            </button>
                          </>
                        ) : null}
                        {row.status === "archived" ? (
                          <span className="text-sm text-[var(--km-fg-muted)]">只读</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {dialog}
    </div>
  );
}
