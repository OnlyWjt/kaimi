import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceBatchRateLimit } from "@/lib/batch-rate-limit";
import { readRechargeBatchOrders } from "@/lib/recharge-batch";

const schema = z.object({
  orderNos: z.array(z.string()).min(1).max(200),
});

export async function POST(req: Request) {
  // 一轮进度一个额度。批量页每 3 秒刷一次，一批跑几分钟也就几十次。
  const limited = await enforceBatchRateLimit(req, "recharge-batch-status", {
    anonymous: 60,
    agent: 120,
  });
  if (limited) return limited;
  try {
    const body = schema.parse(await req.json());
    return NextResponse.json({
      ok: true,
      list: await readRechargeBatchOrders(body.orderNos),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "查询失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
