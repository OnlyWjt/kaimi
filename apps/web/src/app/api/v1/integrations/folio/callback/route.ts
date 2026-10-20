import { NextResponse } from "next/server";
import { bootDb } from "@/lib/config";
import { applyFolioCallback } from "@/lib/folio/callback";
import { parseFolioCallback } from "@/lib/folio/core";
import { verifyFolioRequest } from "@/lib/folio/sign";

/**
 * C 回调：Folio 发信后回写开票结果。必须对原始 body 验签，验过再 JSON.parse。
 * 订单不存在回 404：Folio 遇到 4xx 不重试，会在控制台标「同步失败」。
 */
export async function POST(req: Request) {
  await bootDb();
  const raw = await req.text();
  const verified = await verifyFolioRequest(req, raw);
  if (!verified.ok) {
    return NextResponse.json(
      { status_code: verified.status, msg: verified.error },
      { status: verified.status },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const body = parseFolioCallback(parsed);
  if (!body) return NextResponse.json({ status_code: 400, msg: "回调内容不完整" }, { status: 400 });
  const result = await applyFolioCallback(body, raw);
  if (result.kind === "missing") {
    return NextResponse.json({ status_code: 404, msg: "订单不存在" }, { status: 404 });
  }
  if (result.kind === "duplicate") {
    return NextResponse.json({ status_code: 0, msg: "success", data: { duplicate: true } });
  }
  return NextResponse.json({ status_code: 0, msg: "success", data: { accepted: true } });
}
