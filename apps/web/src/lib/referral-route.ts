import { NextResponse } from "next/server";
import { ReferralError } from "@/lib/referrals";

/** 邀请返券接口共用的错误响应：auth 抛的 Response 原样返回，业务错误带状态码。 */
export function referralFail(error: unknown, fallback: string) {
  if (error instanceof Response) return error;
  const status = error instanceof ReferralError ? error.status : 400;
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

export function positiveId(raw: string) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export function pageQuery(req: Request) {
  const search = new URL(req.url).searchParams;
  return {
    q: search.get("q") || "",
    page: Number(search.get("page") || 1),
    pageSize: Number(search.get("pageSize") || 20),
  };
}
