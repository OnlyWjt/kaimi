import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { adminOrdersCsv, queryAdminOrders } from "@/lib/admin-orders";

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const searchParams = new URL(req.url).searchParams;
  const result = await queryAdminOrders(searchParams);
  if (searchParams.get("export") === "csv") {
    return new NextResponse(adminOrdersCsv(result.list), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="kaimi-orders.csv"',
      },
    });
  }
  return NextResponse.json(result);
}
