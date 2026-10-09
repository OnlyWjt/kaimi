import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { listAgentTelegramBindings, readBindPollError } from "@/lib/telegram-bind";

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json({
    list: await listAgentTelegramBindings(),
    pollError: await readBindPollError(),
  });
}
