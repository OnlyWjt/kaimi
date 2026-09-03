import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  getOpsHealthCached,
  refreshOpsHealth,
  setManualSalesClosed,
} from "@/lib/ops-health";

const schema = z.object({
  action: z.enum(["refresh", "close_sales", "open_sales"]),
});

async function authorize() {
  try {
    return { session: await requireAdmin(), denied: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, denied: error };
    throw error;
  }
}

export async function GET() {
  const { denied } = await authorize();
  if (denied) return denied;
  await bootDb();
  return NextResponse.json({ health: await getOpsHealthCached() });
}

export async function POST(req: Request) {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
  }
  const health =
    parsed.data.action === "refresh"
      ? await refreshOpsHealth()
      : await setManualSalesClosed(parsed.data.action === "close_sales");
  await writeAuditLog({
    actor: session,
    action: `admin.ops_health.${parsed.data.action}`,
    targetType: "ops_health",
  });
  return NextResponse.json({ health });
}
