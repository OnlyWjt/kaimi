import { NextResponse } from "next/server";
import { coverContentType, readAgentPlanCover } from "@/lib/plan-cover";

export async function GET(
  _req: Request,
  context: { params: Promise<{ agentId: string; file: string }> },
) {
  const { agentId: rawId, file } = await context.params;
  const agentId = Number(rawId);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return new NextResponse(null, { status: 404 });
  }
  const bytes = await readAgentPlanCover(agentId, file);
  if (!bytes) return new NextResponse(null, { status: 404 });
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": coverContentType(file),
      "Cache-Control": "public, max-age=86400",
    },
  });
}
