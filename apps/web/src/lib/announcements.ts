import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  platformAnnouncementReads,
  platformAnnouncements,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import type { AuthSession } from "@/lib/auth";
import {
  AGENT_ANNOUNCEMENT_HISTORY_LIMIT,
  ANNOUNCEMENT_LIVE_KEY,
  type AdminAnnouncementRow,
  type AgentAnnouncementRow,
  type AnnouncementAction,
  type AnnouncementStatus,
  type UnreadAnnouncement,
  announcementActionError,
  announcementWriteError,
  isAnnouncementStatus,
  isAnnouncementUnread,
  nextArchivedFields,
  nextPublishedFields,
  normalizeAnnouncementBody,
  normalizeAnnouncementTitle,
  visibleToAgent,
} from "@/lib/announcements-core";

export type { AdminAnnouncementRow, AgentAnnouncementRow, UnreadAnnouncement };

export type AgentNoticesSnapshot = {
  current: AgentAnnouncementRow | null;
  unread: boolean;
  history: AgentAnnouncementRow[];
};

type Actor = Pick<AuthSession, "id" | "role">;

function asStatus(value: string): AnnouncementStatus {
  if (!isAnnouncementStatus(value)) return "draft";
  return value;
}

function throwIfInvalid(error: string | null): asserts error is null {
  if (error) throw new Error(error);
}

function denyAction(status: AnnouncementStatus, action: AnnouncementAction) {
  throwIfInvalid(announcementActionError(status, action));
}

async function getAnnouncement(id: number) {
  const row = await db.query.platformAnnouncements.findFirst({
    where: eq(platformAnnouncements.id, id),
  });
  if (!row) throw new Error("没有这条公告");
  return row;
}

async function countActiveAgents() {
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(agents)
    .where(eq(agents.status, "active"));
  return Number(row?.c ?? 0);
}

async function readCountsByAnnouncement() {
  const rows = await db
    .select({
      announcementId: platformAnnouncementReads.announcementId,
      c: sql<number>`count(*)`,
    })
    .from(platformAnnouncementReads)
    .innerJoin(agents, eq(agents.id, platformAnnouncementReads.agentId))
    .where(eq(agents.status, "active"))
    .groupBy(platformAnnouncementReads.announcementId);
  return new Map(rows.map((row) => [row.announcementId, Number(row.c ?? 0)]));
}

function toAdminRow(
  row: typeof platformAnnouncements.$inferSelect,
  readCount: number,
): AdminAnnouncementRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: asStatus(row.status),
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    readCount,
  };
}

function toAgentRow(row: typeof platformAnnouncements.$inferSelect): AgentAnnouncementRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status === "archived" ? "archived" : "published",
    publishedAt: row.publishedAt || row.createdAt,
    archivedAt: row.archivedAt,
  };
}

export async function listAdminAnnouncements() {
  const [rows, counts, activeAgentCount] = await Promise.all([
    db
      .select()
      .from(platformAnnouncements)
      .orderBy(desc(platformAnnouncements.updatedAt), desc(platformAnnouncements.id)),
    readCountsByAnnouncement(),
    countActiveAgents(),
  ]);
  const list = rows.map((row) => toAdminRow(row, counts.get(row.id) ?? 0));
  return {
    current: list.find((row) => row.status === "published") ?? null,
    drafts: list.filter((row) => row.status === "draft"),
    history: list.filter((row) => row.status !== "draft"),
    activeAgentCount,
  };
}

export async function createAnnouncement(input: {
  title: string;
  body: string;
  publish: boolean;
  actor: Actor;
  ip?: string;
}) {
  const title = normalizeAnnouncementTitle(input.title);
  const body = normalizeAnnouncementBody(input.body);
  throwIfInvalid(announcementWriteError({ title, body, publishing: input.publish }));
  const now = new Date().toISOString();
  const created = await db.transaction(async (tx) => {
    if (input.publish) {
      await tx
        .update(platformAnnouncements)
        .set(nextArchivedFields(now))
        .where(eq(platformAnnouncements.liveKey, ANNOUNCEMENT_LIVE_KEY));
    }
    const [row] = await tx
      .insert(platformAnnouncements)
      .values({
        title,
        body,
        createdByUserId: input.actor.id,
        createdAt: now,
        ...(input.publish
          ? nextPublishedFields(now)
          : { status: "draft", liveKey: null, updatedAt: now }),
      })
      .returning();
    return row;
  });
  if (!created) throw new Error("保存失败");
  await writeAuditLog({
    actor: input.actor,
    action: input.publish ? "publish_announcement" : "create_announcement",
    targetType: "announcement",
    targetId: created.id,
    metadata: { title, published: input.publish },
    ip: input.ip,
  });
  return toAdminRow(created, 0);
}

export async function updateAnnouncement(input: {
  id: number;
  title?: string;
  body?: string;
  actor: Actor;
  ip?: string;
}) {
  const existing = await getAnnouncement(input.id);
  const status = asStatus(existing.status);
  denyAction(status, "edit");
  const title =
    input.title !== undefined ? normalizeAnnouncementTitle(input.title) : existing.title;
  const body =
    input.body !== undefined ? normalizeAnnouncementBody(input.body) : existing.body;
  throwIfInvalid(
    announcementWriteError({
      title,
      body,
      publishing: status === "published",
    }),
  );
  const now = new Date().toISOString();
  await db
    .update(platformAnnouncements)
    .set({ title, body, updatedAt: now })
    .where(eq(platformAnnouncements.id, existing.id));
  await writeAuditLog({
    actor: input.actor,
    action: "update_announcement",
    targetType: "announcement",
    targetId: existing.id,
    metadata: { title },
    ip: input.ip,
  });
}

export async function publishAnnouncement(input: {
  id: number;
  actor: Actor;
  ip?: string;
}) {
  const existing = await getAnnouncement(input.id);
  denyAction(asStatus(existing.status), "publish");
  throwIfInvalid(
    announcementWriteError({
      title: existing.title,
      body: existing.body,
      publishing: true,
    }),
  );
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(platformAnnouncements)
      .set(nextArchivedFields(now))
      .where(eq(platformAnnouncements.liveKey, ANNOUNCEMENT_LIVE_KEY));
    await tx
      .update(platformAnnouncements)
      .set(nextPublishedFields(now, existing.publishedAt))
      .where(eq(platformAnnouncements.id, existing.id));
  });
  await writeAuditLog({
    actor: input.actor,
    action: "publish_announcement",
    targetType: "announcement",
    targetId: existing.id,
    metadata: { title: existing.title },
    ip: input.ip,
  });
}

export async function archiveAnnouncement(input: {
  id: number;
  actor: Actor;
  ip?: string;
}) {
  const existing = await getAnnouncement(input.id);
  denyAction(asStatus(existing.status), "archive");
  const now = new Date().toISOString();
  await db
    .update(platformAnnouncements)
    .set(nextArchivedFields(now))
    .where(eq(platformAnnouncements.id, existing.id));
  await writeAuditLog({
    actor: input.actor,
    action: "archive_announcement",
    targetType: "announcement",
    targetId: existing.id,
    metadata: { title: existing.title },
    ip: input.ip,
  });
}

export async function discardAnnouncement(input: {
  id: number;
  actor: Actor;
  ip?: string;
}) {
  const existing = await getAnnouncement(input.id);
  denyAction(asStatus(existing.status), "discard");
  await db
    .delete(platformAnnouncements)
    .where(eq(platformAnnouncements.id, existing.id));
  await writeAuditLog({
    actor: input.actor,
    action: "discard_announcement",
    targetType: "announcement",
    targetId: existing.id,
    metadata: { title: existing.title },
    ip: input.ip,
  });
}

export async function loadUnreadAnnouncement(
  agentId: number,
): Promise<UnreadAnnouncement | null> {
  const [row] = await db
    .select({
      id: platformAnnouncements.id,
      title: platformAnnouncements.title,
      body: platformAnnouncements.body,
      publishedAt: platformAnnouncements.publishedAt,
      createdAt: platformAnnouncements.createdAt,
      readAt: platformAnnouncementReads.readAt,
    })
    .from(platformAnnouncements)
    .leftJoin(
      platformAnnouncementReads,
      and(
        eq(platformAnnouncementReads.announcementId, platformAnnouncements.id),
        eq(platformAnnouncementReads.agentId, agentId),
      ),
    )
    .where(eq(platformAnnouncements.liveKey, ANNOUNCEMENT_LIVE_KEY))
    .limit(1);
  if (!row || row.readAt) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    publishedAt: row.publishedAt || row.createdAt,
  };
}

export async function loadAgentNotices(agentId: number): Promise<AgentNoticesSnapshot> {
  const rows = await db
    .select()
    .from(platformAnnouncements)
    .where(eq(platformAnnouncements.status, "archived"))
    .orderBy(desc(platformAnnouncements.archivedAt), desc(platformAnnouncements.id))
    .limit(AGENT_ANNOUNCEMENT_HISTORY_LIMIT);
  const live = await db.query.platformAnnouncements.findFirst({
    where: eq(platformAnnouncements.liveKey, ANNOUNCEMENT_LIVE_KEY),
  });
  const current =
    live && visibleToAgent(asStatus(live.status)) ? toAgentRow(live) : null;
  let unread = false;
  if (current) {
    const [read] = await db
      .select({ readAt: platformAnnouncementReads.readAt })
      .from(platformAnnouncementReads)
      .where(
        and(
          eq(platformAnnouncementReads.announcementId, current.id),
          eq(platformAnnouncementReads.agentId, agentId),
        ),
      )
      .limit(1);
    unread = isAnnouncementUnread("published", Boolean(read));
  }
  return {
    current,
    unread,
    history: rows.filter((row) => visibleToAgent(asStatus(row.status))).map(toAgentRow),
  };
}

export async function markAnnouncementRead(announcementId: number, agentId: number) {
  const row = await getAnnouncement(announcementId);
  if (!visibleToAgent(asStatus(row.status))) throw new Error("没有这条公告");
  const now = new Date().toISOString();
  await db
    .insert(platformAnnouncementReads)
    .values({
      announcementId,
      agentId,
      readAt: now,
    })
    .onConflictDoNothing({
      target: [
        platformAnnouncementReads.announcementId,
        platformAnnouncementReads.agentId,
      ],
    });
}
