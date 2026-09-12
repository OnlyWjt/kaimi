import { NextResponse } from "next/server";
import { markAnnouncementRead } from "@/lib/announcements";
import {
  announcementActionHttpStatus,
  parseAnnouncementId,
} from "@/lib/announcements-core";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session: Awaited<ReturnType<typeof requireAgent>>;
  try {
    session = await requireAgent();
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
    await markAnnouncementRead(id, session.agentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "没记上，请再点一次";
    return NextResponse.json(
      { error: message },
      { status: announcementActionHttpStatus(message) },
    );
  }
}
