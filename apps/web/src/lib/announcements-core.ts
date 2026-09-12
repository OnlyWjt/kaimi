export const ANNOUNCEMENT_TITLE_MAX = 40;
export const ANNOUNCEMENT_BODY_MAX = 800;
export const AGENT_ANNOUNCEMENT_HISTORY_LIMIT = 20;
export const ANNOUNCEMENT_LIVE_KEY = "live";

export type AnnouncementStatus = "draft" | "published" | "archived";
export type AnnouncementAction = "edit" | "publish" | "archive" | "discard";

export type UnreadAnnouncement = {
  id: number;
  title: string;
  body: string;
  publishedAt: string;
};

export type LiveAnnouncement = UnreadAnnouncement & { unread: boolean };

/** 弹窗和侧栏「有新的」只用未读的那条。顶栏始终用当前生效的。 */
export function unreadFromLiveAnnouncement(
  live: LiveAnnouncement | null,
): UnreadAnnouncement | null {
  if (!live?.unread) return null;
  return {
    id: live.id,
    title: live.title,
    body: live.body,
    publishedAt: live.publishedAt,
  };
}

export type AdminAnnouncementRow = {
  id: number;
  title: string;
  body: string;
  status: AnnouncementStatus;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  readCount: number;
};

export type AgentAnnouncementRow = {
  id: number;
  title: string;
  body: string;
  status: "published" | "archived";
  publishedAt: string;
  archivedAt: string | null;
};

export const ANNOUNCEMENT_STATUS_LABEL: Record<AnnouncementStatus, string> = {
  draft: "草稿",
  published: "生效中",
  archived: "已下线",
};

const C0_EXCEPT_NEWLINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function isAnnouncementStatus(value: string): value is AnnouncementStatus {
  return value === "draft" || value === "published" || value === "archived";
}

/** 丢掉回车和其他控制符，只留换行。 */
export function sanitizeAnnouncementText(value: string) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(C0_EXCEPT_NEWLINE, "");
}

export function normalizeAnnouncementTitle(value: string) {
  return sanitizeAnnouncementText(value)
    .replace(/\n+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function normalizeAnnouncementBody(value: string) {
  return sanitizeAnnouncementText(value).replace(/[ \t]+\n/g, "\n").trim();
}

export function announcementWriteError(input: {
  title: string;
  body: string;
  publishing: boolean;
}): string | null {
  const title = normalizeAnnouncementTitle(input.title);
  const body = normalizeAnnouncementBody(input.body);
  if (!title) return "标题不能空";
  if (title.length > ANNOUNCEMENT_TITLE_MAX) return "标题最多 40 个字";
  if (input.publishing && !body) return "正文不能空";
  if (body.length > ANNOUNCEMENT_BODY_MAX) return "正文最多 800 个字";
  return null;
}

export function announcementActionError(
  status: AnnouncementStatus,
  action: AnnouncementAction,
): string | null {
  if (action === "edit") {
    return status === "archived" ? "这条已经下线，不能再改" : null;
  }
  if (action === "publish") {
    return status === "draft" ? null : "只有草稿能发布";
  }
  if (action === "archive") {
    return status === "published" ? null : "只有正在生效的能下线";
  }
  return status === "draft" ? null : "只有草稿能删";
}

export function announcementActionHttpStatus(error: string) {
  if (error === "没有这条公告") return 404;
  if (
    error === "这条已经下线，不能再改" ||
    error === "只有草稿能发布" ||
    error === "只有正在生效的能下线" ||
    error === "只有草稿能删"
  ) {
    return 409;
  }
  return 400;
}

export function isAnnouncementUnread(status: AnnouncementStatus, hasRead: boolean) {
  return status === "published" && !hasRead;
}

export function agentAnnouncementHint(unread: boolean) {
  return unread ? "有新的" : "平台";
}

export function parseAnnouncementId(raw: string) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

export function nextArchivedFields(now: string) {
  return {
    status: "archived" as const,
    liveKey: null,
    archivedAt: now,
    updatedAt: now,
  };
}

export function nextPublishedFields(now: string, publishedAt?: string | null) {
  return {
    status: "published" as const,
    liveKey: ANNOUNCEMENT_LIVE_KEY,
    publishedAt: publishedAt || now,
    archivedAt: null,
    updatedAt: now,
  };
}

export function visibleToAgent(status: AnnouncementStatus) {
  return status === "published" || status === "archived";
}
