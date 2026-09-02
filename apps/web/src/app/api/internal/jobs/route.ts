import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { bootDb } from "@/lib/config";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { refreshOpsHealth } from "@/lib/ops-health";

function authorized(req: Request) {
  const expected = process.env.KAIMI_CRON_SECRET?.trim() || "";
  const received =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || Buffer.byteLength(expected) < 24 || !received) {
    return false;
  }
  const expectedHash = createHash("sha256").update(expected).digest();
  const receivedHash = createHash("sha256").update(received).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await bootDb();
  const jobs = await processBackgroundJobs(50);
  const health = await refreshOpsHealth();
  return NextResponse.json({
    ok: true,
    jobs,
    salesOpen: health.salesOpen,
  });
}
