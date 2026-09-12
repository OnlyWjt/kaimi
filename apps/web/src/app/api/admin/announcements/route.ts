import { NextResponse } from "next/server";
import { announcementActionHttpStatus } from "@/lib/announcements-core";
import { createAnnouncement, listAdminAnnouncements } from "@/lib/announcements";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

function requestIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json(await listAdminAnnouncements());
}

export async function POST(req: Request) {
  let session: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const body = (await req.json().catch(() => null)) as {
    title?: unknown;
    body?: unknown;
    publish?: unknown;
  } | null;
  try {
    const created = await createAnnouncement({
      title: typeof body?.title === "string" ? body.title : "",
      body: typeof body?.body === "string" ? body.body : "",
      publish: body?.publish === true,
      actor: session,
      ip: requestIp(req),
    });
    return NextResponse.json({
      ok: true,
      item: created,
      message: created.status === "published" ? "已发布，代理下次打开后台会看到" : "已存草稿",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    return NextResponse.json(
      { error: message },
      { status: announcementActionHttpStatus(message) },
    );
  }
}
