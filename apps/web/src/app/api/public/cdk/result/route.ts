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
      return NextResponse.json({
        status: result.status,
        message: result.message,
        ...result.payload,
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
