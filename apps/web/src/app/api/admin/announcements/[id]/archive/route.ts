import { NextResponse } from "next/server";
import { archiveAnnouncement } from "@/lib/announcements";
import {
  announcementActionHttpStatus,
  parseAnnouncementId,
} from "@/lib/announcements-core";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  const id = parseAnnouncementId((await context.params).id);
  if (!id) {
    return NextResponse.json({ error: "没有这条公告" }, { status: 404 });
  }
  await bootDb();
  try {
    await archiveAnnouncement({
      id,
      actor: session,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });
    return NextResponse.json({ ok: true, message: "已下线" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "下线失败";
    return NextResponse.json(
      { error: message },
      { status: announcementActionHttpStatus(message) },
    );
  }
}
