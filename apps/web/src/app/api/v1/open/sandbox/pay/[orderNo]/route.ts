import { after, NextResponse } from "next/server";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { bootDb } from "@/lib/config";
import { payTestOrder, SandboxError } from "@/lib/open-api/sandbox";
import { enforceRateLimit } from "@/lib/rate-limit";

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * 测试 Key 下单返回的 pay_url。打开即视为付款成功：订单直接发齐假卡，推 order.paid / order.delivered，
 * 有 return_url 就跳回去，和正式支付完成后的流程一样。不会产生任何真实扣款。
 */
export async function GET(req: Request, context: { params: Promise<{ orderNo: string }> }) {
  const limited = enforceRateLimit(req, "sandbox-pay", 30);
  if (limited) return limited;
  await bootDb();
  const { orderNo } = await context.params;
  const token = new URL(req.url).searchParams.get("t") || "";
  let result: Awaited<ReturnType<typeof payTestOrder>>;
  try {
    result = await payTestOrder(orderNo, token);
  } catch (error) {
    const message = error instanceof SandboxError ? error.message : "模拟付款失败";
    return page("模拟付款失败", escapeHtml(message), error instanceof SandboxError ? 404 : 500);
  }
  // 回调已经入队，这里只是让它立刻发出；失败也有调度器兜底，不能把付款成功报成失败。
  if (result.newlyPaid) {
    try {
      after(() => processBackgroundJobs(4).catch(() => undefined));
    } catch {
      /* 调度器下一轮会发 */
    }
  }
  if (result.returnUrl) return NextResponse.redirect(result.returnUrl, 302);
  return page(
    "测试订单已模拟付款",
    `订单 ${escapeHtml(result.order.orderNo)} 已记为付款成功并发出测试卡密。这是测试模式，没有产生真实扣款。`,
  );
}
