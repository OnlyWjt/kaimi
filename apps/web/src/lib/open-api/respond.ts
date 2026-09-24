import { NextResponse } from "next/server";
import { OPEN_API_ERRORS, type OpenApiErrorCode } from "./errors";

export function openRequestId() {
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function openOk(data: unknown, requestId = openRequestId()) {
  return NextResponse.json({ data, request_id: requestId });
}

export function openFail(code: OpenApiErrorCode, message: string, requestId = openRequestId()) {
  return NextResponse.json(
    { error: { code, message }, request_id: requestId },
    { status: OPEN_API_ERRORS[code] },
  );
}
