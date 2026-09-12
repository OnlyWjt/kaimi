import { NextResponse } from "next/server";
import { loadAgentNotices } from "@/lib/announcements";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function GET() {
  let session: Awaited<ReturnType<typeof requireAgent>>;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json(await loadAgentNotices(session.agentId));
}
