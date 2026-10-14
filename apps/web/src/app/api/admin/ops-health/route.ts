import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  getOpsHealthCached,
  refreshOpsHealth,
  setManualSalesClosed,
  setSpendableThresholds,
} from "@/lib/ops-health";

/** 余额线上限 100 万（按卡台币种），防止手滑多打几个 0 把店关了。 */
const MAX_THRESHOLD_CENTS = 100_000_000;
const cents = z.number().int().min(0).max(MAX_THRESHOLD_CENTS);

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["refresh", "close_sales", "open_sales"]) }),
  z.object({
    action: z.literal("set_thresholds"),
    minSpendableCents: cents,
    warnSpendableCents: cents,
  }),
]);

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
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
  }
  const input = parsed.data;
  if (input.action === "set_thresholds" && input.warnSpendableCents < input.minSpendableCents) {
    return NextResponse.json({ error: "预警线不能低于关店线" }, { status: 400 });
  }
  const health =
    input.action === "set_thresholds"
      ? await setSpendableThresholds(input.minSpendableCents, input.warnSpendableCents)
      : input.action === "refresh"
        ? await refreshOpsHealth()
        : await setManualSalesClosed(input.action === "close_sales");
  await writeAuditLog({
    actor: session,
    action: `admin.ops_health.${input.action}`,
    targetType: "ops_health",
    metadata:
      input.action === "set_thresholds"
        ? { minSpendableCents: input.minSpendableCents, warnSpendableCents: input.warnSpendableCents }
        : undefined,
  });
  return NextResponse.json({ health });
}
