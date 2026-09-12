import { NextResponse } from "next/server";
import {
  discardAnnouncement,
  updateAnnouncement,
} from "@/lib/announcements";
import {
  announcementActionHttpStatus,
  parseAnnouncementId,
} from "@/lib/announcements-core";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

function requestIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
}

async function authorize() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await authorize();
  if (session instanceof Response) return session;
  const id = parseAnnouncementId((await context.params).id);
  if (!id) {
    return NextResponse.json({ error: "没有这条公告" }, { status: 404 });
  }
  await bootDb();
  const body = (await req.json().catch(() => null)) as {
    title?: unknown;
    body?: unknown;
  } | null;
  try {
    await updateAnnouncement({
      id,
      title: typeof body?.title === "string" ? body.title : undefined,
      body: typeof body?.body === "string" ? body.body : undefined,
      actor: session,
      ip: requestIp(req),
    });
    return NextResponse.json({ ok: true, message: "已改好，看过的人不会再弹一次" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    return NextResponse.json(
      { error: message },
      { status: announcementActionHttpStatus(message) },
    );
  }
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await authorize();
  if (session instanceof Response) return session;
  const id = parseAnnouncementId((await context.params).id);
  if (!id) {
    return NextResponse.json({ error: "没有这条公告" }, { status: 404 });
  }
  await bootDb();
  try {
    await discardAnnouncement({ id, actor: session, ip: requestIp(req) });
    return NextResponse.json({ ok: true, message: "草稿已删" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除失败";
    return NextResponse.json(
      { error: message },
      { status: announcementActionHttpStatus(message) },
    );
  }
}
