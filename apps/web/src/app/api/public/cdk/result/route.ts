import { NextResponse } from "next/server";
import { pollCardplatformResult } from "@/lib/cardplatform/redeem";
import { pollRechargeByRequestId, pollRechargeIfNeeded } from "@/lib/orders";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const limited = enforceRateLimit(req, "public-cdk-result", 30);
  if (limited) return limited;
  const url = new URL(req.url);
  const token = url.searchParams.get("token")?.trim() || "";
  const requestId = url.searchParams.get("request_id")?.trim() || "";
  const orderNo = url.searchParams.get("orderNo")?.trim() || "";
  try {
    if (orderNo) {
      const order = await pollRechargeIfNeeded(orderNo);
      return NextResponse.json({
        orderNo: order?.orderNo,
        status: order?.fulfillStatus,
        message: order?.message,
        request_id: order?.upstreamRequestId,
      });
    }
    const rid = requestId || (token.startsWith("cp:") ? token : token ? `cp:0:${token}` : "");
    if (!rid) {
      return NextResponse.json({ error: "缺少 token 或订单号" }, { status: 400 });
    }
    if (rid.startsWith("cp:")) {
      const result = await pollCardplatformResult(rid);
      await pollRechargeByRequestId(rid).catch(() => null);
      // 这个接口不带鉴权，所以只回规整过的字段。原始报文里有卡 id、发卡行、内部
      // 错误码和报价，以前是整个摊出去的，那些只该出现在管理端。
      return NextResponse.json({
        status: result.status,
        message: result.message,
        order: result.upstream.order,
        events: result.upstream.events.map((event) => ({
          step: event.step,
          category: event.category,
          message: event.message,
          created_at: event.at,
        })),
      });
    }
    return NextResponse.json({ error: "无效的兑换请求" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询失败" },
      { status: 400 },
    );
  }
}
