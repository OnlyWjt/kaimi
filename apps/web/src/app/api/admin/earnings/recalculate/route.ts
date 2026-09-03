import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { recalculateEstimatedFees } from "@/lib/payments/recalculate";

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const body = (await req.json().catch(() => ({}))) as {
    releaseSettlements?: unknown;
  };
  try {
    const result = await recalculateEstimatedFees({
      releaseSettlements: body.releaseSettlements === true,
    });
    await writeAuditLog({
      actor: session,
      action: "admin.earnings.recalculate_fees",
      targetType: "store_order",
      metadata: result,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "重算手续费失败" },
      { status: 400 },
    );
  }
}
