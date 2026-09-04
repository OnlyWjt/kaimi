import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceBatchRateLimit } from "@/lib/batch-rate-limit";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";
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
    // 一轮进度对每张非终态的单都要打一次卡台，所以这里也得夹进后台配的上限，
    // 不能只靠 zod 的 200。校验和提交都是这么夹的。
    const limit = await getBatchRedeemLimit();
    const orderNos = [...new Set(body.orderNos.map((no) => no.trim()).filter(Boolean))]
      .slice(0, limit);
    if (!orderNos.length) {
      return NextResponse.json({ error: "请提供要查询的单号" }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      list: await readRechargeBatchOrders(orderNos),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "查询失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
