import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent } from "@/lib/auth";
import { applyForDraw, createDrawOrder, DrawError, getAgentDrawState } from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";

export async function GET() {
  try {
    const session = await requireAgent();
    await bootDb();
    return NextResponse.json(await getAgentDrawState(session.agentId));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("apply"),
    contact: z.string().trim().min(1).max(80),
    expectedMonthly: z.string().trim().max(40).default(""),
    note: z.string().trim().max(500).default(""),
  }),
  z.object({
    action: z.literal("draw"),
    requestId: z.string().trim().min(8).max(80),
    planKey: z.string().trim().min(1).max(64),
    quantity: z.number().int().positive(),
    regionConfirmed: z.boolean().optional(),
  }),
]);

export async function POST(req: Request) {
  try {
    const session = await requireAgent();
    await bootDb();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数无效" }, { status: 400 });
    }
    if (parsed.data.action === "apply") {
      await applyForDraw(session.agentId, parsed.data);
      return NextResponse.json({ ok: true });
    }
    const result = await createDrawOrder(session.agentId, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof DrawError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "提卡失败" },
      { status },
    );
  }
}
