import { NextResponse } from "next/server";
import { ReconciliationError } from "@/lib/reconciliation";

export function newRequestId() {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

export function clientIp(req: Request) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    ""
  );
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
