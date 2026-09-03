import { after, NextResponse } from "next/server";
import { bootDb } from "@/lib/config";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { epayReady, getEpayConfig } from "@/lib/payments/config";
import { confirmStoreOrderPaid } from "@/lib/payments/confirm-store-order";
import { verifyEpayNotify } from "@/lib/payments/epay";
import { sanitizeLog } from "@/lib/log";

async function readParams(req: Request) {
  const params: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((value, key) => {
    params[key] = value;
  });
  if (req.method !== "GET") {
    const form = new URLSearchParams(await req.text());
    form.forEach((value, key) => {
      params[key] = value;
    });
  }
  return params;
}

function text(value: string, status = 200) {
  return new NextResponse(value, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handle(req: Request) {
  await bootDb();
  const config = await getEpayConfig();
  if (!epayReady(config)) return text("fail", 503);

  const params = await readParams(req);
  const verification = verifyEpayNotify(config, params);
  if (!verification.ok) {
    if (verification.error === "trade not success") return text("success");
    return text("fail", 400);
  }

  const result = await confirmStoreOrderPaid({
    orderNo: String(params.out_trade_no || "").trim(),
    moneyYuan: String(params.money || ""),
    tradeNo: String(params.trade_no || "").trim(),
    rawParams: params,
  });
  if (result.kind === "missing") return text("success");
  if (result.kind === "rejected") return text("fail", result.status);

  after(async () => {
    await processBackgroundJobs(4).catch((error) => {
      console.error(
        `[store-order] background job failed order=${result.order.orderNo}`,
        sanitizeLog(error instanceof Error ? error.message : "unknown error"),
      );
    });
  });
  return text("success");
}

export const GET = handle;
export const POST = handle;
