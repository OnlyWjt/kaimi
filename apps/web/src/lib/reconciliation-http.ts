import { NextResponse } from "next/server";
import { ReconciliationError } from "@/lib/reconciliation";

// 审计里的 IP 和限流同一个口径：XFF 第一段客户端能随便写，不能当真实来源。
export { clientIp } from "@/lib/rate-limit";

export function newRequestId() {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

export function idempotencyKey(req: Request) {
  return req.headers.get("idempotency-key")?.trim() || "";
}

export function reconciliationData(data: unknown, requestId: string, status = 200) {
  return NextResponse.json({ data, requestId }, { status });
}

export function reconciliationFail(error: unknown, requestId: string) {
  if (error instanceof ReconciliationError) {
    return NextResponse.json(
      {
        error: { code: error.code, message: error.message, retryable: error.retryable },
        requestId,
      },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : "对账失败";
  return NextResponse.json(
    { error: { code: "INVALID_STATE", message, retryable: false }, requestId },
    { status: 500 },
  );
}
